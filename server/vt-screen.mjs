// Lightweight, zero-dependency VT100 shadow screen tracker.
// Tracks exact cells (char + SGR), scroll regions (DECSTBM), and cursor state for
// agy's TUI (both alternate-screen and inline modes) so tui-proxy.mjs can cleanly
// overlay Fabric rows and restore non-Fabric rows without drift.

const isWideCodePoint = cp => {
  if (cp < 0x1100) return false
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
    (cp >= 0x3250 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4c6) ||
    (cp >= 0xa960 && cp <= 0xa97c) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6b) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

const isCombiningCodePoint = cp =>
  (cp >= 0x0300 && cp <= 0x036f) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xfe20 && cp <= 0xfe2f) ||
  cp === 0x200d

export const charWidth = ch => {
  if (!ch) return 0
  const cp = ch.codePointAt(0)
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (isCombiningCodePoint(cp)) return 0
  if (cp === 0x26a1) return 2 // wide high-voltage symbol
  return isWideCodePoint(cp) ? 2 : 1
}

export const visualWidth = str => {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

export const truncateVisual = (str, maxCols) => {
  if (maxCols <= 0) return ''
  let w = 0
  let out = ''
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    out += ch
    w += cw
  }
  return out
}

const blankCell = () => ({ ch: ' ', sgr: '', w: 1 })
const makeRow = cols => Array.from({ length: cols }, blankCell)

const makeSgrState = () => ({ flags: new Set(), fg: '', bg: '' })
const cloneSgrState = st => ({ flags: new Set(st.flags), fg: st.fg, bg: st.bg })
const formatSgrState = st => {
  const parts = []
  for (const f of st.flags) parts.push(String(f))
  if (st.fg) parts.push(st.fg)
  if (st.bg) parts.push(st.bg)
  return parts.length > 0 ? `\x1b[${parts.join(';')}m` : ''
}

const applySgrParams = (st, paramsStr) => {
  if (!paramsStr) {
    st.flags.clear()
    st.fg = ''
    st.bg = ''
    return
  }
  const nums = paramsStr.split(';').map(s => (s === '' ? 0 : Number(s)))
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i]
    if (!Number.isFinite(n)) continue
    if (n === 0) {
      st.flags.clear()
      st.fg = ''
      st.bg = ''
    } else if (n >= 1 && n <= 9) {
      st.flags.add(n)
    } else if (n === 21 || n === 22) {
      st.flags.delete(1)
      st.flags.delete(2)
    } else if (n === 23) {
      st.flags.delete(3)
    } else if (n === 24) {
      st.flags.delete(4)
    } else if (n === 25) {
      st.flags.delete(5)
      st.flags.delete(6)
    } else if (n === 27) {
      st.flags.delete(7)
    } else if (n === 28) {
      st.flags.delete(8)
    } else if (n === 29) {
      st.flags.delete(9)
    } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
      st.fg = String(n)
    } else if (n === 39) {
      st.fg = ''
    } else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
      st.bg = String(n)
    } else if (n === 49) {
      st.bg = ''
    } else if (n === 38 || n === 48) {
      const mode = nums[i + 1]
      if (mode === 5 && i + 2 < nums.length) {
        const val = `${n};5;${nums[i + 2]}`
        if (n === 38) st.fg = val
        else st.bg = val
        i += 2
      } else if (mode === 2 && i + 4 < nums.length) {
        const val = `${n};2;${nums[i + 2]};${nums[i + 3]};${nums[i + 4]}`
        if (n === 38) st.fg = val
        else st.bg = val
        i += 4
      }
    }
  }
}

export class VtScreen {
  constructor(cols = 120, rows = 40) {
    this.cols = Math.max(20, cols)
    this.rows = Math.max(5, rows)
    this.grid = Array.from({ length: this.rows }, () => makeRow(this.cols))
    this.rowOverlaid = Array.from({ length: this.rows }, () => false)
    this.row = 0
    this.col = 0
    this.scrollTop = 0
    this.scrollBottom = this.rows - 1
    this.sgrState = makeSgrState()
    this.curSgr = ''
    this.cursorVisible = true
    this.saved = { row: 0, col: 0, sgrState: makeSgrState(), curSgr: '' }
    this.mainScreen = null
    this.lastChar = ''
    this.pending = ''
    this.inAltScreen = false
  }

  hasOverlaidRows() {
    for (let r = 0; r < this.rowOverlaid.length; r++) {
      if (this.rowOverlaid[r]) return true
    }
    return false
  }

  clearOverlaidFlags() {
    this.rowOverlaid.fill(false)
  }

  resize(cols, rows) {
    const nextCols = Math.max(20, cols)
    const nextRows = Math.max(5, rows)
    const nextGrid = Array.from({ length: nextRows }, (_, r) => {
      const row = makeRow(nextCols)
      const old = this.grid[r]
      if (old) {
        const limit = Math.min(nextCols, old.length)
        for (let c = 0; c < limit; c++) row[c] = old[c]
      }
      return row
    })
    const nextOverlaid = Array.from({ length: nextRows }, (_, r) => Boolean(this.rowOverlaid[r]))
    this.cols = nextCols
    this.rows = nextRows
    this.grid = nextGrid
    this.rowOverlaid = nextOverlaid
    this.scrollTop = 0
    this.scrollBottom = this.rows - 1
    this.row = Math.min(this.row, this.rows - 1)
    this.col = Math.min(this.col, this.cols - 1)
  }

  clearScreen() {
    this.grid = Array.from({ length: this.rows }, () => makeRow(this.cols))
    this.rowOverlaid = Array.from({ length: this.rows }, () => false)
  }

  clearRow(r, fromCol = 0, toCol = this.cols) {
    const row = this.grid[r]
    if (!row) return
    const start = Math.max(0, fromCol)
    const end = Math.min(this.cols, toCol)
    for (let c = start; c < end; c++) row[c] = blankCell()
    if (start === 0 && end >= this.cols) {
      this.rowOverlaid[r] = false
    }
  }

  scrollUp(n = 1, top = this.scrollTop, bottom = this.scrollBottom) {
    const t = Math.max(0, Math.min(this.rows - 1, top))
    const b = Math.max(t, Math.min(this.rows - 1, bottom))
    const height = b - t + 1
    if (height <= 0) return
    const count = Math.min(Math.max(1, n), height)
    this.grid.splice(t, count)
    this.grid.splice(b - count + 1, 0, ...Array.from({ length: count }, () => makeRow(this.cols)))
    this.rowOverlaid.splice(t, count)
    this.rowOverlaid.splice(b - count + 1, 0, ...Array.from({ length: count }, () => false))
  }

  scrollDown(n = 1, top = this.scrollTop, bottom = this.scrollBottom) {
    const t = Math.max(0, Math.min(this.rows - 1, top))
    const b = Math.max(t, Math.min(this.rows - 1, bottom))
    const height = b - t + 1
    if (height <= 0) return
    const count = Math.min(Math.max(1, n), height)
    this.grid.splice(b - count + 1, count)
    this.grid.splice(t, 0, ...Array.from({ length: count }, () => makeRow(this.cols)))
    this.rowOverlaid.splice(b - count + 1, count)
    this.rowOverlaid.splice(t, 0, ...Array.from({ length: count }, () => false))
  }

  lineFeed() {
    if (this.row === this.scrollBottom) {
      this.scrollUp(1)
    } else if (this.row < this.rows - 1) {
      this.row += 1
    }
  }

  reverseIndex() {
    if (this.row === this.scrollTop) {
      this.scrollDown(1)
    } else if (this.row > 0) {
      this.row -= 1
    }
  }

  enterAltScreen(saveMain) {
    if (saveMain && !this.inAltScreen) {
      this.mainScreen = {
        cols: this.cols,
        rows: this.rows,
        grid: this.grid,
        rowOverlaid: this.rowOverlaid,
        row: this.row,
        col: this.col,
        scrollTop: this.scrollTop,
        scrollBottom: this.scrollBottom,
        sgrState: cloneSgrState(this.sgrState),
        curSgr: this.curSgr,
      }
    }
    this.inAltScreen = true
    this.scrollTop = 0
    this.scrollBottom = this.rows - 1
    this.clearScreen()
    this.row = 0
    this.col = 0
  }

  leaveAltScreen(restoreMain) {
    this.inAltScreen = false
    if (restoreMain && this.mainScreen && this.mainScreen.cols === this.cols && this.mainScreen.rows === this.rows) {
      const m = this.mainScreen
      this.grid = m.grid
      this.rowOverlaid = m.rowOverlaid
      this.row = Math.min(this.rows - 1, m.row)
      this.col = Math.min(this.cols - 1, m.col)
      this.scrollTop = 0
      this.scrollBottom = this.rows - 1
      this.sgrState = m.sgrState
      this.curSgr = m.curSgr
      this.mainScreen = null
      return
    }
    this.mainScreen = null
    this.scrollTop = 0
    this.scrollBottom = this.rows - 1
    this.clearScreen()
    this.row = 0
    this.col = 0
  }

  putChar(ch) {
    const w = charWidth(ch)
    if (w === 0) {
      // Combining mark attaches to previous cell
      const prevCol = Math.min(this.col, this.cols) - 1
      if (prevCol >= 0 && this.grid[this.row]?.[prevCol]) {
        this.grid[this.row][prevCol].ch += ch
      }
      return
    }
    if (this.col >= this.cols) {
      this.col = 0
      this.lineFeed()
    }
    if (w === 2 && this.col === this.cols - 1) {
      this.grid[this.row][this.col] = blankCell()
      this.col = 0
      this.lineFeed()
    }
    const row = this.grid[this.row]
    if (!row) return
    // If overwriting second half of a wide char, blank its leader
    if (row[this.col]?.w === 0 && this.col > 0) {
      row[this.col - 1] = blankCell()
    }
    // If overwriting leader of a wide char with a narrow char, blank its trailer
    if (row[this.col]?.w === 2 && w === 1 && this.col + 1 < this.cols) {
      row[this.col + 1] = blankCell()
    }
    row[this.col] = { ch, sgr: this.curSgr, w }
    if (w === 2 && this.col + 1 < this.cols) {
      if (row[this.col + 1]?.w === 2 && this.col + 2 < this.cols) {
        row[this.col + 2] = blankCell()
      }
      row[this.col + 1] = { ch: '', sgr: this.curSgr, w: 0 }
    }
    this.col += w
    this.lastChar = ch
  }

  handleCsi(paramsStr, finalByte) {
    const isPriv = /^[?<>=]/.test(paramsStr)
    const hasInterm = /[ !"#$%&'()*+,\-./]/.test(paramsStr)
    if (hasInterm) return
    const clean = isPriv ? paramsStr.slice(1) : paramsStr
    const nums = clean ? clean.split(';').map(s => (s === '' ? 0 : Number(s))) : []
    const p1 = nums[0] || 0
    const p2 = nums[1] || 0

    if (paramsStr.startsWith('?')) {
      if (finalByte === 'h') {
        for (const n of nums) {
          if (n === 25) this.cursorVisible = true
          if (n === 1049) this.enterAltScreen(true)
          else if (n === 47 || n === 1047) this.enterAltScreen(false)
        }
      } else if (finalByte === 'l') {
        for (const n of nums) {
          if (n === 25) this.cursorVisible = false
          if (n === 1049) this.leaveAltScreen(true)
          else if (n === 47 || n === 1047) this.leaveAltScreen(false)
        }
      }
      return
    }
    if (isPriv) return

    switch (finalByte) {
      case 'H':
      case 'f':
        this.row = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1))
        this.col = Math.max(0, Math.min(this.cols - 1, (p2 || 1) - 1))
        break
      case 'A': {
        const minRow = this.row >= this.scrollTop ? this.scrollTop : 0
        this.row = Math.max(minRow, this.row - (p1 || 1))
        break
      }
      case 'B':
      case 'e': {
        const maxRow = this.row <= this.scrollBottom ? this.scrollBottom : this.rows - 1
        this.row = Math.min(maxRow, this.row + (p1 || 1))
        break
      }
      case 'C':
      case 'a':
        this.col = Math.min(this.cols - 1, this.col + (p1 || 1))
        break
      case 'D':
        this.col = Math.max(0, Math.min(this.cols - 1, this.col) - (p1 || 1))
        break
      case 'E': {
        const maxRow = this.row <= this.scrollBottom ? this.scrollBottom : this.rows - 1
        this.row = Math.min(maxRow, this.row + (p1 || 1))
        this.col = 0
        break
      }
      case 'F': {
        const minRow = this.row >= this.scrollTop ? this.scrollTop : 0
        this.row = Math.max(minRow, this.row - (p1 || 1))
        this.col = 0
        break
      }
      case 'G':
      case '`':
        this.col = Math.max(0, Math.min(this.cols - 1, (p1 || 1) - 1))
        break
      case 'd':
        this.row = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1))
        break
      case 'r': {
        // DECSTBM: Set Top and Bottom Margins (1-indexed), homes cursor
        const top = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1))
        const bottom = Math.max(0, Math.min(this.rows - 1, (p2 || this.rows) - 1))
        if (top < bottom) {
          this.scrollTop = top
          this.scrollBottom = bottom
        } else {
          this.scrollTop = 0
          this.scrollBottom = this.rows - 1
        }
        this.row = 0
        this.col = 0
        break
      }
      case 'S':
        // SU: Scroll Up N lines within active scroll region
        this.scrollUp(p1 || 1)
        break
      case 'T':
        // SD: Scroll Down N lines within active scroll region (ignore 5-param mouse highlight)
        if (nums.length <= 1) this.scrollDown(p1 || 1)
        break
      case 'J': {
        const mode = p1 || 0
        if (mode === 0) {
          this.clearRow(this.row, this.col, this.cols)
          for (let r = this.row + 1; r < this.rows; r++) this.clearRow(r)
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r++) this.clearRow(r)
          this.clearRow(this.row, 0, Math.min(this.cols, this.col + 1))
        } else if (mode === 2 || mode === 3) {
          this.clearScreen()
        }
        break
      }
      case 'K': {
        const mode = p1 || 0
        if (mode === 0) this.clearRow(this.row, this.col, this.cols)
        else if (mode === 1) this.clearRow(this.row, 0, Math.min(this.cols, this.col + 1))
        else if (mode === 2) this.clearRow(this.row, 0, this.cols)
        break
      }
      case 'P': {
        const n = p1 || 1
        const row = this.grid[this.row]
        if (row && this.col < this.cols) {
          row.splice(this.col, n)
          while (row.length < this.cols) row.push(blankCell())
        }
        break
      }
      case '@': {
        const n = p1 || 1
        const row = this.grid[this.row]
        if (row && this.col < this.cols) {
          row.splice(this.col, 0, ...Array.from({ length: n }, blankCell))
          row.length = this.cols
        }
        break
      }
      case 'X': {
        const n = p1 || 1
        this.clearRow(this.row, this.col, this.col + n)
        break
      }
      case 'L': {
        if (this.row >= this.scrollTop && this.row <= this.scrollBottom) {
          this.scrollDown(p1 || 1, this.row, this.scrollBottom)
        }
        break
      }
      case 'M': {
        if (this.row >= this.scrollTop && this.row <= this.scrollBottom) {
          this.scrollUp(p1 || 1, this.row, this.scrollBottom)
        }
        break
      }
      case 'b': {
        if (this.lastChar) {
          const n = Math.min(this.cols, p1 || 1)
          for (let k = 0; k < n; k++) this.putChar(this.lastChar)
        }
        break
      }
      case 'm': {
        applySgrParams(this.sgrState, paramsStr)
        this.curSgr = formatSgrState(this.sgrState)
        break
      }
      case 's':
        this.saved = {
          row: this.row,
          col: this.col,
          sgrState: cloneSgrState(this.sgrState),
          curSgr: this.curSgr,
        }
        break
      case 'u':
        this.row = Math.min(this.rows - 1, this.saved.row)
        this.col = Math.min(this.cols - 1, this.saved.col)
        this.sgrState = cloneSgrState(this.saved.sgrState)
        this.curSgr = this.saved.curSgr
        break
    }
  }

  feed(chunk) {
    const s = this.pending + chunk
    this.pending = ''
    let i = 0
    const len = s.length

    while (i < len) {
      const code = s.charCodeAt(i)
      if (code === 0x1b) {
        if (i + 1 >= len) {
          this.pending = s.slice(i)
          break
        }
        const next = s[i + 1]
        if (next === '[') {
          // CSI sequence
          let j = i + 2
          while (j < len && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++
          if (j >= len) {
            this.pending = s.slice(i)
            break
          }
          const paramsStr = s.slice(i + 2, j)
          const finalByte = s[j]
          this.handleCsi(paramsStr, finalByte)
          i = j + 1
          continue
        }
        if (next === ']') {
          // OSC sequence terminated by BEL or ST (ESC \)
          let j = i + 2
          let found = -1
          while (j < len) {
            if (s.charCodeAt(j) === 0x07) {
              found = j + 1
              break
            }
            if (s.charCodeAt(j) === 0x1b && j + 1 < len && s[j + 1] === '\\') {
              found = j + 2
              break
            }
            j++
          }
          if (found < 0) {
            this.pending = s.slice(i)
            break
          }
          i = found
          continue
        }
        if (next === 'P' || next === '_' || next === '^') {
          // DCS / APC / PM terminated by ST
          let j = i + 2
          let found = -1
          while (j < len - 1) {
            if (s.charCodeAt(j) === 0x1b && s[j + 1] === '\\') {
              found = j + 2
              break
            }
            j++
          }
          if (found < 0) {
            this.pending = s.slice(i)
            break
          }
          i = found
          continue
        }
        if (next === '(' || next === ')' || next === '*' || next === '+') {
          if (i + 2 >= len) {
            this.pending = s.slice(i)
            break
          }
          i += 3
          continue
        }
        if (next === '7') {
          this.saved = {
            row: this.row,
            col: this.col,
            sgrState: cloneSgrState(this.sgrState),
            curSgr: this.curSgr,
          }
        } else if (next === '8') {
          this.row = Math.min(this.rows - 1, this.saved.row)
          this.col = Math.min(this.cols - 1, this.saved.col)
          this.sgrState = cloneSgrState(this.saved.sgrState)
          this.curSgr = this.saved.curSgr
        } else if (next === 'M') {
          this.reverseIndex()
        } else if (next === 'D') {
          this.lineFeed()
        } else if (next === 'E') {
          this.col = 0
          this.lineFeed()
        } else if (next === 'c') {
          this.scrollTop = 0
          this.scrollBottom = this.rows - 1
          this.clearScreen()
          this.row = 0
          this.col = 0
          this.sgrState = makeSgrState()
          this.curSgr = ''
          this.inAltScreen = false
          this.mainScreen = null
        }
        i += 2
        continue
      }

      if (code === 0x0d) {
        this.col = 0
        i++
        continue
      }
      if (code === 0x0a || code === 0x0b || code === 0x0c) {
        this.lineFeed()
        i++
        continue
      }
      if (code === 0x08) {
        if (this.col >= this.cols) this.col = Math.max(0, this.cols - 2)
        else if (this.col > 0) this.col -= 1
        i++
        continue
      }
      if (code === 0x09) {
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8)
        i++
        continue
      }
      if (code < 0x20 || code === 0x7f) {
        i++
        continue
      }

      // Decode full UTF-16 surrogate pair if present
      const cp = s.codePointAt(i)
      const chLen = cp > 0xffff ? 2 : 1
      if (chLen === 2 && i + 1 >= len) {
        this.pending = s.slice(i)
        break
      }
      this.putChar(s.slice(i, i + chLen))
      i += chLen
    }
  }

  getRowText(r) {
    const row = this.grid[r]
    if (!row) return ''
    let out = ''
    for (let c = 0; c < row.length; c++) {
      if (row[c].w === 0) continue
      out += row[c].ch
    }
    return out.replace(/\s+$/, '')
  }

  renderRowAnsi(r) {
    const row = this.grid[r]
    if (!row) return ''
    let lastNonSpace = -1
    for (let c = row.length - 1; c >= 0; c--) {
      if (row[c].ch !== ' ' || row[c].sgr !== '') {
        lastNonSpace = c
        break
      }
    }
    if (lastNonSpace < 0) return ''
    let out = ''
    let curSgr = ''
    for (let c = 0; c <= lastNonSpace; c++) {
      const cell = row[c]
      if (cell.w === 0) continue
      if (cell.sgr !== curSgr) {
        out += '\x1b[0m' + cell.sgr
        curSgr = cell.sgr
      }
      out += cell.ch
    }
    if (curSgr) out += '\x1b[0m'
    return out
  }
}
