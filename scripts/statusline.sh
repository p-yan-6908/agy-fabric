#!/usr/bin/env bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

input="$(cat)"
[ -z "$input" ] && exit 0

uid="${UID:-501}"
state_file="/tmp/agy-statusline-${uid}.json"
fabric_dir="/tmp/agy-fabric-${uid}"
mkdir -p "${fabric_dir}/sessions" 2>/dev/null || true

if [ ! -s "$state_file" ]; then
  printf '%s\n' '{}' > "$state_file" 2>/dev/null || true
fi

# Persist latest non-zero current_usage per session so cache% never flickers,
# and write live context telemetry for Fabric's `compact.pressure()` & auto-staging.
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

if [ -n "$telemetry_json" ]; then
  tel_tmp="${fabric_dir}/telemetry.json.$$"
  printf '%s\n' "$telemetry_json" > "$tel_tmp" 2>/dev/null && mv -f "$tel_tmp" "${fabric_dir}/telemetry.json" 2>/dev/null || true
  tel_sid="$(jq -r '.session_id // empty' <<< "$telemetry_json" 2>/dev/null)"
  if [ -n "$tel_sid" ]; then
    sid_tmp="${fabric_dir}/sessions/tel-${tel_sid}.json.$$"
    printf '%s\n' "$telemetry_json" > "$sid_tmp" 2>/dev/null && mv -f "$sid_tmp" "${fabric_dir}/sessions/tel-${tel_sid}.json" 2>/dev/null || true
  fi
  if [ -n "${PPID:-}" ]; then
    ppid_tmp="${fabric_dir}/sessions/tel-pid-${PPID}.json.$$"
    printf '%s\n' "$telemetry_json" > "$ppid_tmp" 2>/dev/null && mv -f "$ppid_tmp" "${fabric_dir}/sessions/tel-pid-${PPID}.json" 2>/dev/null || true
  fi
fi

pending_tok=""
tel_cwd="$(jq -r '.cwd // empty' <<< "$telemetry_json" 2>/dev/null)"
if [ -n "$tel_cwd" ] && [ -s "${tel_cwd}/.pi/fabric/compaction/pending.json" ]; then
  pending_tok="$(jq -r '.estimatedTokensAfter // empty' "${tel_cwd}/.pi/fabric/compaction/pending.json" 2>/dev/null)"
fi

fabric_runs_file="${fabric_dir}/sessions/runs-${PPID:-0}.json"
fabric_badge=""
if [ -s "$fabric_runs_file" ]; then
  fabric_badge="$(jq -r '
    if .active != null then
      "run:" + (.active.name // "fabric")
    elif ((.totals.runs // 0) > 0) then
      "done:" + ((.totals.runs // 0) | tostring) + ":" + ((.totals.ops // 0) | tostring) + ":" + ((.totals.errors // 0) | tostring)
    else
      ""
    end
  ' "$fabric_runs_file" 2>/dev/null || true)"
fi

jq -r --slurpfile prev "$state_file" --arg ptok "$pending_tok" --arg fbadge "$fabric_badge" '
  def ansi($code; $s): "\u001b[" + $code + "m" + $s + "\u001b[0m";
  def dim($s): ansi("2"; $s);
  def bold($s): ansi("1"; $s);
  def green($s): ansi("32"; $s);
  def yellow($s): ansi("33"; $s);
  def red($s): ansi("31"; $s);
  def cyan($s): ansi("36"; $s);
  def magenta($s): ansi("35"; $s);

  def fmt_tok($n):
    if $n >= 1000000 then
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
    (if ($ptok | length) > 0 then " " + cyan("⚡~" + fmt_tok($ptok | tonumber)) else "" end)
  ) as $ctx_seg |

  # 3. Session tokens used
  ($tot_in + $tot_out) as $tot_tok |
  (.terminal_width // 120) as $width |
  (if $width >= 105 then
     "tok " + bold(fmt_tok($tot_tok)) + dim(" (↑" + fmt_tok($tot_in) + " ↓" + fmt_tok($tot_out) + ")")
   else
     "tok " + bold(fmt_tok($tot_tok))
   end) as $tok_seg |

  # 4. Cache hit rate (with fallback to last turn in same session)
  (.session_id // .conversation_id // "") as $sid |
  ($prev[0] // {}) as $p |
  (.context_window.current_usage // {}) as $live_cur |
  (($live_cur.input_tokens // 0) + ($live_cur.cache_creation_input_tokens // 0) + ($live_cur.cache_read_input_tokens // $live_cur.cached_tokens // 0)) as $live_denom |
  (if $live_denom > 0 then
     $live_cur
   elif ($sid != "") and (($p.session_id // "") == $sid) then
     ($p.current_usage // {})
   else
     {}
   end) as $cur |
  ($cur.cache_read_input_tokens // $cur.cached_tokens // 0) as $cache_read |
  ($cur.cache_creation_input_tokens // 0) as $cache_write |
  ($cur.input_tokens // 0) as $cur_in |
  ($cur_in + $cache_write + $cache_read) as $cache_denom |
  (if $cache_denom > 0 then
     (($cache_read * 100 / $cache_denom) | round) as $cpct |
     "cache " + cyan(($cpct | tostring) + "%")
   else
     "cache " + dim("--")
   end) as $cache_seg |

  # 5. Quota (5h & weekly remaining % matched to active model family: gemini vs 3p)
  def pick_quota($entries; $win_re; $fam_re):
    ($entries | map(select(.key | test($win_re; "i")))) as $cand |
    (($cand | map(select(.key | test($fam_re; "i"))) | .[0].value) // ($cand | .[0].value));

  ((.model.id // "") + " " + (.model.display_name // "")) as $model_ident |
  (if ($model_ident | test("claude|sonnet|opus|haiku|gpt|openai|anthropic|3p"; "i")) then
     "^3p[-_]|3p"
   else
     "^gemini[-_]|gemini"
   end) as $qfam_re |
  (.quota // {} | to_entries) as $qentries |
  pick_quota($qentries; "5h|5hr|five|short"; $qfam_re) as $q5 |
  pick_quota($qentries; "week|7d|wk"; $qfam_re) as $qw |
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

  # 6. Optional Fabric live activity badge (when fabric_exec has run in this session)
  (if ($fbadge | startswith("run:")) then
     yellow("⚡ " + ($fbadge | sub("^run:"; "")))
   elif ($fbadge | startswith("done:")) then
     (($fbadge | sub("^done:"; "") | split(":")) as $fp |
      ($fp[0] | tonumber) as $fruns |
      ($fp[1] | tonumber) as $fops |
      ($fp[2] | tonumber) as $ferr |
      cyan("⚡ " + ($fruns | tostring) + "r") + dim("·" + ($fops | tostring) + "op") +
        (if $ferr > 0 then " " + red("✗" + ($ferr | tostring)) else "" end))
   else
     ""
   end) as $fabric_seg |

  dim(" │ ") as $sep |
  ([magenta($model_label), $ctx_seg, $tok_seg, $cache_seg, $quota_seg] +
    (if ($fabric_seg | length) > 0 then [$fabric_seg] else [] end)
  ) | join($sep)
' <<< "$input" 2>/dev/null
