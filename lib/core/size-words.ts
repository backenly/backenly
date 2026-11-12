/** "1.2 GB", for a sentence. Pure, so the console's finding panels can use it. */
export function sizeWords(bytes: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return i === 0 ? `${n} bytes` : `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} ${units[i]}`
}
