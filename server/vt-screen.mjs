// Lightweight, zero-dependency VT100 shadow screen tracker.
// Tracks exact cells (char + SGR) and cursor state for agy's full-screen TUI so
// tui-proxy.mjs can cleanly overlay Fabric rows and restore non-Fabric rows without drift.

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

export class VtScreen {
  constructor(cols = 120, rows = 40) {
    this.cols = Math.max(20, cols)
    this.rows = Math.max(5, rows)
    this.grid = Array.from({ length: this.rows }, () => makeRow(this.cols))
    this.row = 0
    this.col = 0
    this.curSgr = ''
    this.cursorVisible = true
    this.saved = { row: 0, col: 0, sgr: '' }
    this.pending = ''
    this.inAltScreen = false
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
    this.cols = nextCols
    this.rows = nextRows
    this.grid = nextGrid
    this.row = Math.min(this.row, this.rows - 1)
    this.col = Math.min(this.col, this.cols - 1)
  }

  clearScreen() {
    this.grid = Array.from({ length: this.rows }, () => makeRow(this.cols))
  }

  clearRow(r, fromCol = 0, toCol = this.cols) {
    const row = this.grid[r]
    if (!row) return
    const start = Math.max(0, fromCol)
    const end = Math.min(this.cols, toCol)
    for (let c = start; c < end; c++) row[c] = blankCell()
  }

  scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      this.grid.shift()
      this.grid.push(makeRow(this.cols))
    }
  }

  scrollDown(n = 1) {
    for (let i = 0; i < n; i++) {
      this.grid.pop()
      this.grid.unshift(makeRow(this.cols))
    }
  }

  putChar(ch) {
    const w = charWidth(ch)
    if (w === 0) {
      // Combining mark attaches to previous cell
      if (this.col > 0 && this.grid[this.row]?.[this.col - 1]) {
        this.grid[this.row][this.col - 1].ch += ch
      }
      return
    }
    if (this.col >= this.cols) {
      this.col = 0
      if (this.row < this.rows - 1) this.row += 1
      else this.scrollUp(1)
    }
    if (w === 2 && this.col === this.cols - 1) {
      this.grid[this.row][this.col] = blankCell()
      this.col = 0
      if (this.row < this.rows - 1) this.row += 1
      else this.scrollUp(1)
    }
    const row = this.grid[this.row]
    if (!row) return
    // If overwriting second half of a wide char, blank its leader
    if (row[this.col]?.w === 0 && this.col > 0) {
      row[this.col - 1] = blankCell()
    }
    row[this.col] = { ch, sgr: this.curSgr, w }
    if (w === 2 && this.col + 1 < this.cols) {
      row[this.col + 1] = { ch: '', sgr: this.curSgr, w: 0 }
    }
    this.col += w
  }

  handleCsi(paramsStr, finalByte) {
    const isPriv = paramsStr.startsWith('?') || paramsStr.startsWith('>') || paramsStr.startsWith('=')
    const clean = isPriv ? paramsStr.slice(1) : paramsStr
    const nums = clean ? clean.split(';').map(s => (s === '' ? 0 : Number(s))) : []
    const p1 = nums[0] || 0
    const p2 = nums[1] || 0

    if (paramsStr.startsWith('?')) {
      if (finalByte === 'h') {
        for (const n of nums) {
          if (n === 25) this.cursorVisible = true
          if (n === 1049 || n === 47 || n === 1047) {
            this.inAltScreen = true
            this.clearScreen()
            this.row = 0
            this.col = 0
          }
        }
      } else if (finalByte === 'l') {
        for (const n of nums) {
          if (n === 25) this.cursorVisible = false
          if (n === 1049 || n === 47 || n === 1047) {
            this.inAltScreen = false
            this.clearScreen()
            this.row = 0
            this.col = 0
          }
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
      case 'A':
        this.row = Math.max(0, this.row - (p1 || 1))
        break
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + (p1 || 1))
        break
      case 'C':
        this.col = Math.min(this.cols - 1, this.col + (p1 || 1))
        break
      case 'D':
        this.col = Math.max(0, this.col - (p1 || 1))
        break
      case 'E':
        this.row = Math.min(this.rows - 1, this.row + (p1 || 1))
        this.col = 0
        break
      case 'F':
        this.row = Math.max(0, this.row - (p1 || 1))
        this.col = 0
        break
      case 'G':
        this.col = Math.max(0, Math.min(this.cols - 1, (p1 || 1) - 1))
        break
      case 'd':
        this.row = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1))
        break
      case 'J': {
        const mode = p1 || 0
        if (mode === 0) {
          this.clearRow(this.row, this.col, this.cols)
          for (let r = this.row + 1; r < this.rows; r++) this.clearRow(r)
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r++) this.clearRow(r)
          this.clearRow(this.row, 0, this.col + 1)
        } else if (mode === 2 || mode === 3) {
          this.clearScreen()
        }
        break
      }
      case 'K': {
        const mode = p1 || 0
        if (mode === 0) this.clearRow(this.row, this.col, this.cols)
        else if (mode === 1) this.clearRow(this.row, 0, this.col + 1)
        else if (mode === 2) this.clearRow(this.row, 0, this.cols)
        break
      }
      case 'P': {
        const n = p1 || 1
        const row = this.grid[this.row]
        if (row) {
          row.splice(this.col, n)
          while (row.length < this.cols) row.push(blankCell())
        }
        break
      }
      case '@': {
        const n = p1 || 1
        const row = this.grid[this.row]
        if (row) {
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
        const n = p1 || 1
        for (let i = 0; i < n; i++) {
          this.grid.splice(this.row, 0, makeRow(this.cols))
          this.grid.pop()
        }
        break
      }
      case 'M': {
        const n = p1 || 1
        for (let i = 0; i < n; i++) {
          this.grid.splice(this.row, 1)
          this.grid.push(makeRow(this.cols))
        }
        break
      }
      case 'm': {
        if (!paramsStr || paramsStr === '0') {
          this.curSgr = ''
        } else {
          const seq = `\x1b[${paramsStr}m`
          if (paramsStr.startsWith('0;')) this.curSgr = seq
          else this.curSgr = (this.curSgr + seq).slice(-96)
        }
        break
      }
      case 's':
        this.saved = { row: this.row, col: this.col, sgr: this.curSgr }
        break
      case 'u':
        this.row = Math.min(this.rows - 1, this.saved.row)
        this.col = Math.min(this.cols - 1, this.saved.col)
        this.curSgr = this.saved.sgr
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
          this.saved = { row: this.row, col: this.col, sgr: this.curSgr }
        } else if (next === '8') {
          this.row = Math.min(this.rows - 1, this.saved.row)
          this.col = Math.min(this.cols - 1, this.saved.col)
          this.curSgr = this.saved.sgr
        } else if (next === 'M') {
          if (this.row > 0) this.row -= 1
          else this.scrollDown(1)
        } else if (next === 'D') {
          if (this.row < this.rows - 1) this.row += 1
          else this.scrollUp(1)
        } else if (next === 'E') {
          this.col = 0
          if (this.row < this.rows - 1) this.row += 1
          else this.scrollUp(1)
        } else if (next === 'c') {
          this.clearScreen()
          this.row = 0
          this.col = 0
          this.curSgr = ''
        }
        i += 2
        continue
      }

      if (code === 0x0d) {
        this.col = 0
        i++
        continue
      }
      if (code === 0x0a) {
        if (this.row < this.rows - 1) this.row += 1
        else this.scrollUp(1)
        i++
        continue
      }
      if (code === 0x08) {
        if (this.col > 0) this.col -= 1
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
