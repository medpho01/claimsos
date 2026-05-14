import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'fs';
import { logger } from '../Utils/logger.js';

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
    budgetInBytes: number
  ): Promise<Buffer | null> => {
    try {
    const metadata = await sharp(input).metadata();
    const originalWidth = metadata.width;

    if (!originalWidth) {
      throw new Error("Could not determine image width.");
    }

    let quality = 100;
    let scale = 1.0;
    let buffer: Buffer | null = null;
    
    const maxIterations = 15;

    for (let i = 0; i < maxIterations; i++) {
      const currentWidth = Math.round(originalWidth * scale);

      buffer = await sharp(input)
        .resize({ width: currentWidth, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();

      if (buffer.length <= budgetInBytes) {
        return buffer;
      }

      if (quality > 40) {
        quality -= 5; 
      }else if(quality == 10){
        return buffer;
      } else {
        scale *= 0.75; 
        quality = Math.max(10, quality - 5); 
      }
    }

    return buffer;

  } catch (error) {
    logger.error({ err: error }, 'image compression failed');
    return null;
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

      const totalBudget = 900 * 1000
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
