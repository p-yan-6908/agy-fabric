#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

input="$(cat)"
[ -z "$input" ] && exit 0

uid="${UID:-501}"
fabric_dir="/tmp/agy-fabric-${uid}"
mkdir -p "${fabric_dir}/sessions" 2>/dev/null || true

# Write live context telemetry for Fabric's `compact.pressure()` & auto-staging.
telemetry_json="$(jq -c '
  {
    session_id: (.session_id // .conversation_id // null),
    transcript_path: (.transcript_path // null),
    cwd: (.workspace.current_dir // .cwd // null),
    total_input_tokens: (.context_window.total_input_tokens // 0),
    total_output_tokens: (.context_window.total_output_tokens // 0),
    context_window_size: (.context_window.context_window_size // 1048576),
    used_percentage: (.context_window.used_percentage // 0),
    current_usage: (.context_window.current_usage // null),
    updated_at: (now * 1000 | round)
  }
' <<< "$input" 2>/dev/null)"

tel_sid=""
tel_cwd=""
tel_tp=""
if [ -n "$telemetry_json" ]; then
  tel_tmp="${fabric_dir}/telemetry.json.$$"
  printf '%s\n' "$telemetry_json" > "$tel_tmp" 2>/dev/null && mv -f "$tel_tmp" "${fabric_dir}/telemetry.json" 2>/dev/null || true
  {
    IFS= read -r tel_sid
    IFS= read -r tel_cwd
    IFS= read -r tel_tp
  } <<< "$(jq -r '(.session_id // ""), (.cwd // ""), (.transcript_path // "")' <<< "$telemetry_json" 2>/dev/null)"
  if [ -n "$tel_sid" ]; then
    sid_tmp="${fabric_dir}/sessions/tel-${tel_sid}.json.$$"
    printf '%s\n' "$telemetry_json" > "$sid_tmp" 2>/dev/null && mv -f "$sid_tmp" "${fabric_dir}/sessions/tel-${tel_sid}.json" 2>/dev/null || true
  fi
  if [ -n "${PPID:-}" ]; then
    ppid_tmp="${fabric_dir}/sessions/tel-pid-${PPID}.json.$$"
    printf '%s\n' "$telemetry_json" > "$ppid_tmp" 2>/dev/null && mv -f "$ppid_tmp" "${fabric_dir}/sessions/tel-pid-${PPID}.json" 2>/dev/null || true
  fi
fi

safe_sid=""
case "$tel_sid" in
  ""|*[!A-Za-z0-9._-]*|.|..) ;;
  *) safe_sid="$tel_sid" ;;
esac

# Persist latest non-zero current_usage per session so fallback cache% never flickers
# (per-session file prevents concurrent agy windows from overwriting each other).
if [ -n "$safe_sid" ]; then
  state_file="${fabric_dir}/sessions/state-${safe_sid}.json"
else
  state_file="/tmp/agy-statusline-${uid}.json"
fi
if [ ! -s "$state_file" ]; then
  printf '%s\n' '{}' > "$state_file" 2>/dev/null || true
fi

new_state="$(jq -c '
  (.context_window.current_usage // {}) as $cur |
  (($cur.input_tokens // 0) + ($cur.cache_creation_input_tokens // 0) + ($cur.cache_read_input_tokens // $cur.cached_tokens // 0)) as $denom |
  if ($denom > 0) and ((.session_id // .conversation_id // "") != "") then
    { session_id: (.session_id // .conversation_id), current_usage: $cur }
  else
    empty
  end
' <<< "$input" 2>/dev/null)"

if [ -n "$new_state" ]; then
  tmp_file="${state_file}.$$"
  printf '%s\n' "$new_state" > "$tmp_file" 2>/dev/null && mv -f "$tmp_file" "$state_file" 2>/dev/null || true
fi

# Aggregate cumulative session tokens & cache hits from the session's transcript.jsonl
# (agy's context_window.total_input_tokens only tracks current-turn context size, and
# current_usage only tracks the last turn). Cached by (size:mtime:inode) per session.
transcript_file=""
if [ -n "$tel_tp" ]; then
  case "$tel_tp" in
    */brain/.system_generated/logs/transcript.jsonl) ;;
    *)
      if [ -r "$tel_tp" ]; then
        transcript_file="$tel_tp"
      else
        _old_root='/.gemini/antigravity/brain/'
        _new_root='/.gemini/antigravity-cli/brain/'
        alt_tp="${tel_tp/"$_old_root"/"$_new_root"}"
        if [ "$alt_tp" != "$tel_tp" ] && [ -r "$alt_tp" ]; then
          transcript_file="$alt_tp"
        fi
      fi
      ;;
  esac
fi
if [ -z "$transcript_file" ] && [ -n "$safe_sid" ]; then
  for brain_root in "$HOME/.gemini/antigravity-cli/brain" "$HOME/.gemini/antigravity/brain"; do
    for tname in transcript.jsonl transcript_full.jsonl; do
      cand="${brain_root}/${safe_sid}/.system_generated/logs/${tname}"
      if [ -r "$cand" ]; then
        transcript_file="$cand"
        break 2
      fi
    done
  done
fi

session_usage="null"
if [ -n "$transcript_file" ]; then
  t_sig="$(stat -f '%z:%m:%i' "$transcript_file" 2>/dev/null || stat -c '%s:%Y:%i' "$transcript_file" 2>/dev/null || true)"
  usage_cache_file=""
  [ -n "$safe_sid" ] && usage_cache_file="${fabric_dir}/sessions/usage-${safe_sid}.json"
  cached_usage=""
  if [ -n "$usage_cache_file" ] && [ -s "$usage_cache_file" ] && [ -n "$t_sig" ]; then
    cached_usage="$(jq -c --arg sig "$t_sig" --arg path "$transcript_file" 'select(.sig == $sig and .path == $path and .last_in != null)' "$usage_cache_file" 2>/dev/null || true)"
  fi
  if [ -n "$cached_usage" ]; then
    session_usage="$cached_usage"
  else
    computed_usage="$(jq -Rnc --arg sig "$t_sig" --arg path "$transcript_file" '
      reduce inputs as $line ({sig: $sig, path: $path, in: 0, cr: 0, cc: 0, out: 0, turns: 0, last_in: 0, last_cr: 0, last_cc: 0};
        (try ($line | fromjson) catch null) as $e |
        if ($e | type) == "object" and (
          ($e.input_tokens != null) or
          ($e.output_tokens != null) or
          ($e.cache_read_tokens != null) or
          ($e.cache_read_input_tokens != null) or
          ($e.cache_creation_tokens != null) or
          ($e.cache_creation_input_tokens != null)
        ) then
          ($e.input_tokens // 0) as $ei |
          ($e.cache_read_tokens // $e.cache_read_input_tokens // 0) as $ecr |
          ($e.cache_creation_tokens // $e.cache_creation_input_tokens // 0) as $ecc |
          .in += $ei
          | .cr += $ecr
          | .cc += $ecc
          | .out += ($e.output_tokens // 0)
          | .turns += 1
          | if ($ei + $ecr + $ecc) > 0 then
              .last_in = $ei | .last_cr = $ecr | .last_cc = $ecc
            else . end
        else
          .
        end
      )
    ' "$transcript_file" 2>/dev/null || true)"
    if [ -n "$computed_usage" ]; then
      session_usage="$computed_usage"
      if [ -n "$usage_cache_file" ] && [ -n "$t_sig" ]; then
        u_tmp="${usage_cache_file}.$$"
        printf '%s\n' "$computed_usage" > "$u_tmp" 2>/dev/null && mv -f "$u_tmp" "$usage_cache_file" 2>/dev/null || true
      fi
    fi
  fi
fi

pending_tok=""
if [ -n "$tel_cwd" ] && [ -s "${tel_cwd}/.pi/fabric/compaction/pending.json" ]; then
  pending_tok="$(jq -r '.estimatedTokensAfter // empty' "${tel_cwd}/.pi/fabric/compaction/pending.json" 2>/dev/null)"
fi

jq -r --slurpfile prev "$state_file" --argjson sess "$session_usage" --arg ptok "$pending_tok" '
  def ansi($code; $s): "\u001b[" + $code + "m" + $s + "\u001b[0m";
  def dim($s): ansi("2"; $s);
  def bold($s): ansi("1"; $s);
  def green($s): ansi("32"; $s);
  def yellow($s): ansi("33"; $s);
  def red($s): ansi("31"; $s);
  def cyan($s): ansi("36"; $s);
  def magenta($s): ansi("35"; $s);

  def fmt_tok($n):
    if $n >= 1000000000 then
      ((($n / 1000000000) * 100 | round) / 100 | tostring) + "B"
    elif $n >= 10000000 then
      ((($n / 1000000) * 10 | round) / 10 | tostring) + "M"
    elif $n >= 1000000 then
      ((($n / 1000000) * 100 | round) / 100 | tostring) + "M"
    elif $n >= 1000 then
      ((($n / 1000) * 10 | round) / 10 | tostring) + "k"
    else
      ($n | round | tostring)
    end;

  def fmt_pct1($n):
    ((($n * 10) | round) / 10 | tostring) + "%";

  def color_high_bad($pct; $s):
    if $pct >= 80 then red($s)
    elif $pct >= 50 then yellow($s)
    else green($s)
    end;

  def color_low_bad($rem_pct; $s):
    if $rem_pct <= 15 then red($s)
    elif $rem_pct <= 40 then yellow($s)
    else green($s)
    end;

  # 1. Model (effort)
  (.model.display_name // .model.id // "no-model") as $raw_model |
  (.model.effort // "") as $effort |
  (if ($effort | length) > 0 then
     ($raw_model | sub("\\s*\\([^)]*\\)$"; "")) + " (" + ($effort | ascii_downcase) + ")"
   else
     $raw_model
   end) as $model_label |

  # 2. Context %
  (.context_window.total_input_tokens // 0) as $tot_in |
  (.context_window.total_output_tokens // 0) as $tot_out |
  (.context_window.context_window_size // 0) as $ctx_size |
  (.context_window.used_percentage //
    (if $ctx_size > 0 then (($tot_in + $tot_out) * 100 / $ctx_size) else 0 end)
  ) as $ctx_pct |
  ("ctx " + fmt_pct1($ctx_pct)) as $ctx_plain |
  (color_high_bad($ctx_pct; $ctx_plain) +
    (if ($ptok | length) > 0 then " " + cyan("[~" + fmt_tok($ptok | tonumber) + "]") else "" end)
  ) as $ctx_seg |

  # 3 & 4. Cumulative session tokens used & cache hit rate (last turn + session avg)
  (.session_id // .conversation_id // "") as $sid |
  ($prev[0] // {}) as $p |
  (.context_window.current_usage // {}) as $live_cur |
  ($live_cur.input_tokens // 0) as $lc_in |
  ($live_cur.cache_creation_input_tokens // 0) as $lc_cc |
  ($live_cur.cache_read_input_tokens // $live_cur.cached_tokens // 0) as $lc_cr |
  ($live_cur.output_tokens // 0) as $lc_out |
  ($lc_in + $lc_cc + $lc_cr) as $live_denom |
  (if $live_denom > 0 then
     $live_cur
   elif ($sid != "") and (($p.session_id // "") == $sid) then
     ($p.current_usage // {})
   else
     {}
   end) as $cur |
  ($cur.input_tokens // 0) as $cur_in |
  ($cur.cache_creation_input_tokens // 0) as $cur_cc |
  ($cur.cache_read_input_tokens // $cur.cached_tokens // 0) as $cur_cr |
  ($cur.output_tokens // 0) as $cur_out |
  ($cur_in + $cur_cc + $cur_cr) as $cur_denom |

  (($sess | type) == "object" and (($sess.turns // 0) > 0)) as $has_sess |
  # If transcript.jsonl lags the just-completed turn by 1 turn, fold in live current_usage
  # without double-counting once flushed to disk.
  ($has_sess and $lc_out > 0 and $tot_out == (($sess.out // 0) + $lc_out)) as $sess_lagging |
  (if $has_sess then
     (($sess.in // 0) + (if $sess_lagging then $lc_in else 0 end)) as $s_in |
     (($sess.cc // 0) + (if $sess_lagging then $lc_cc else 0 end)) as $s_cc |
     (($sess.cr // 0) + (if $sess_lagging then $lc_cr else 0 end)) as $s_cr |
     (($sess.out // 0) + (if $sess_lagging then $lc_out else 0 end)) as $s_out |
     { in_tot: ($s_in + $s_cc + $s_cr), out_tot: $s_out, cache_read: $s_cr, cache_denom: ($s_in + $s_cc + $s_cr) }
   elif $cur_denom > 0 then
     { in_tot: $cur_denom, out_tot: (if $tot_out > $cur_out then $tot_out else $cur_out end), cache_read: $cur_cr, cache_denom: $cur_denom }
   else
     { in_tot: $tot_in, out_tot: $tot_out, cache_read: 0, cache_denom: 0 }
   end) as $usage |

  ($usage.in_tot + $usage.out_tot) as $sess_tok |
  (.terminal_width // 120) as $width |
  (if $width >= 105 then
     "tok " + bold(fmt_tok($sess_tok)) + dim(" (↑" + fmt_tok($usage.in_tot) + " ↓" + fmt_tok($usage.out_tot) + ")")
   else
     "tok " + bold(fmt_tok($sess_tok))
   end) as $tok_seg |

  ((($sess.last_in // 0) + ($sess.last_cc // 0) + ($sess.last_cr // 0))) as $sess_last_denom |
  (if $live_denom > 0 then
     { cr: $lc_cr, denom: $live_denom }
   elif $has_sess and $sess_last_denom > 0 then
     { cr: ($sess.last_cr // 0), denom: $sess_last_denom }
   elif $cur_denom > 0 then
     { cr: $cur_cr, denom: $cur_denom }
   else
     { cr: 0, denom: 0 }
   end) as $last_cache |

  (if $last_cache.denom > 0 then
     (($last_cache.cr * 100 / $last_cache.denom) | round) as $last_cpct |
     (if $has_sess and $usage.cache_denom > 0 and $width >= 90 then
        (($usage.cache_read * 100 / $usage.cache_denom) | round) as $avg_cpct |
        "cache " + cyan(($last_cpct | tostring) + "%") + dim(" (avg " + ($avg_cpct | tostring) + "%)")
      else
        "cache " + cyan(($last_cpct | tostring) + "%")
      end)
   elif $usage.cache_denom > 0 then
     (($usage.cache_read * 100 / $usage.cache_denom) | round) as $avg_cpct |
     "cache " + cyan(($avg_cpct | tostring) + "%")
   else
     "cache " + dim("--")
   end) as $cache_seg |

  # 5. Quota (5h & weekly remaining % matched to active model family: gemini vs 3p)
  # Prefer exact canonical keys (<family>-5h, <family>-weekly) so model-specific
  # sub-buckets (e.g. gemini-*-weekly) that sort earlier alphabetically never shadow the main quota.
  def pick_quota($map; $exact_key; $win_re; $fam):
    if ($map[$exact_key] != null) then
      $map[$exact_key]
    else
      ($map | to_entries | map(select(.key | test($win_re; "i")))) as $cand |
      (
        ($cand | map(select(.key | test("^" + $fam + "[-_]|" + $fam; "i"))) | sort_by(.key | length) | .[0].value)
        // ($cand | sort_by(.key | length) | .[0].value)
      )
    end;

  ((.model.id // "") + " " + (.model.display_name // "")) as $model_ident |
  (if ($model_ident | test("claude|sonnet|opus|haiku|gpt|openai|anthropic|3p"; "i")) then
     "3p"
   else
     "gemini"
   end) as $qfam |
  (.quota // {}) as $qmap |
  pick_quota($qmap; $qfam + "-5h"; "5h|5hr|five|short"; $qfam) as $q5 |
  pick_quota($qmap; $qfam + "-weekly"; "week|7d|wk"; $qfam) as $qw |
  (if $q5 != null and ($q5.remaining_fraction != null) then
     (($q5.remaining_fraction * 100) | round) as $p5 |
     "5h:" + color_low_bad($p5; ($p5 | tostring) + "%")
   else
     "5h:" + dim("--")
   end) as $q5_str |
  (if $qw != null and ($qw.remaining_fraction != null) then
     (($qw.remaining_fraction * 100) | round) as $pw |
     "wk:" + color_low_bad($pw; ($pw | tostring) + "%")
   else
     "wk:" + dim("--")
   end) as $qw_str |
  ("quota " + $q5_str + " " + $qw_str) as $quota_seg |

  dim(" │ ") as $sep |
  [magenta($model_label), $ctx_seg, $tok_seg, $cache_seg, $quota_seg] | join($sep)
' <<< "$input" 2>/dev/null
