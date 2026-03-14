import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'fs';

type ImageInput = string | Buffer;

export default class PDFHandler {
  /**
   * Single-pass image compression.
   * Picks optimal quality + dimensions based on budget, compresses in ONE pipeline call.
   * Falls back to one more aggressive pass only if the first exceeds the budget.
   *
   * Previous approach: up to 5 iterative sharp calls per image (very slow).
   * New approach: 1-2 sharp calls per image (5x faster).
   */
  private compressImage = async (
    input: ImageInput,
    budgetPerImage: number
  ): Promise<Buffer | null> => {
    try {
      const metadata = await sharp(input).metadata()
      const width = metadata.width || 1200

      // Pick quality + max dimension based on budget (no trial-and-error)
      let quality: number
      let maxWidth: number

      if (budgetPerImage > 200 * 1024) {
        quality = 60; maxWidth = 1400
      } else if (budgetPerImage > 100 * 1024) {
        quality = 45; maxWidth = 1200
      } else if (budgetPerImage > 50 * 1024) {
        quality = 35; maxWidth = 1000
      } else {
        quality = 25; maxWidth = 800
      }

      // Single pipeline: resize (if needed) + compress in one call
      let pipeline = sharp(input).jpeg({ quality, mozjpeg: true })
      if (width > maxWidth) {
        pipeline = pipeline.resize(maxWidth)
      }

      let buffer = await pipeline.toBuffer()

      // Safety fallback: if still over budget, ONE more aggressive pass
      if (buffer.length > budgetPerImage) {
        buffer = await sharp(buffer)
          .resize(Math.round(maxWidth * 0.6))
          .jpeg({ quality: Math.max(15, quality - 15), mozjpeg: true })
          .toBuffer()
      }

      return buffer
    } catch (err: any) {
      console.warn(`[PDFHandler] Skipping unsupported image: ${err.message}`)
      return null
    }
  }

  createPdfFromImages = async (
    images: ImageInput[],
    outputPath: string
  ): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false, compress: true })
      const stream = fs.createWriteStream(outputPath)
      doc.pipe(stream)

      const totalBudget = 900 * 1024
      const budgetPerImage = totalBudget / images.length

      try {
        let addedPages = 0
        for (const img of images) {
          const compressedBuffer = await this.compressImage(img, budgetPerImage)
          if (!compressedBuffer) continue

          const imgMetadata = await sharp(compressedBuffer).metadata()

          doc.addPage({
            size: [imgMetadata.width!, imgMetadata.height!],
            margin: 0,
          })

          doc.image(compressedBuffer, 0, 0, {
            width: imgMetadata.width,
            height: imgMetadata.height,
          })
          addedPages++
        }

        if (addedPages === 0) {
          doc.end()
          reject(new Error('No valid images found for PDF generation'))
          return
        }

        doc.end()
      } catch (error) {
        reject(error)
      }

      stream.on('finish', () => resolve())
      stream.on('error', (err) => reject(err))
    })
  }
}
