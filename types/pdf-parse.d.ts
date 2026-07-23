// Minimal ambient declaration for pdf-parse (optional dependency).
// The real package may not be installed — the code handles that with a dynamic
// import().catch(() => null) guard. This declaration only silences the TS error.
declare module 'pdf-parse' {
  interface PdfData {
    numpages: number
    numrender: number
    info: Record<string, unknown>
    metadata: Record<string, unknown>
    text: string
    version: string
  }
  function pdfParse(dataBuffer: Buffer, options?: Record<string, unknown>): Promise<PdfData>
  export = pdfParse
}
