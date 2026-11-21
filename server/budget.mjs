// Fitting a program's result to a context budget while preserving JSON shape.

export const clip = (text, maxChars = 4000) => {
  const source = typeof text === 'string' ? text : (JSON.stringify(text, null, 2) ?? String(text))
  if (source.length <= maxChars) return source
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head - 40)
  return `${source.slice(0, head)}\n…[+${source.length - head - tail} chars]…\n${tail > 0 ? source.slice(-tail) : ''}`
}

const shrink = (value, maxString, maxItems) => {
  if (typeof value === 'string') return clip(value, maxString)
  if (Array.isArray(value)) {
    if (value.length <= maxItems) return value.map(item => shrink(item, maxString, maxItems))
    const head = Math.ceil(maxItems * 0.7)
    const tail = maxItems - head
    return [
      ...value.slice(0, head).map(item => shrink(item, maxString, maxItems)),
      `…[+${value.length - maxItems} of ${value.length} items]…`,
      ...(tail > 0 ? value.slice(-tail).map(item => shrink(item, maxString, maxItems)) : []),
    ]
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item, maxString, maxItems)]))
  }
  return value
}

export const textOf = (value, indent) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, indent) ?? String(value))

export const fit = (value, maxChars, indent) => {
  if (typeof value === 'string') {
    return { text: clip(value, maxChars), full: value, isClipped: value.length > maxChars }
  }
  const full = textOf(value, indent)
  if (full.length <= maxChars) return { text: full, full, isClipped: false }
  for (const [maxString, maxItems] of [
    [4000, 200],
    [2000, 100],
    [1000, 50],
    [500, 30],
    [250, 16],
    [120, 8],
  ]) {
    const text = JSON.stringify(shrink(value, maxString, maxItems), null, indent) ?? ''
    if (text.length <= maxChars) return { text, full, isClipped: true }
  }
  return { text: clip(full, maxChars), full, isClipped: true }
}
