import { parentPort, workerData } from 'worker_threads'
import driveHandler from '../Services/driveUploader.service.js'
import PDFHandler from '../Services/pdfConverter.service.js'

import fs from 'fs'

const DriveHandler = new driveHandler()
const pdfHandler = new PDFHandler()

const run = async () => {
  const { folderId } = workerData

  try {
    const subfolders = await DriveHandler.getFolders(folderId)
    console.log(subfolders)
    const uploads = []
    let ImgPaths: string[] = []
    for (let folder of subfolders) {
      const images = await DriveHandler.listFiles(folder?.fileId || '')
      const imgPaths: string[] = []
      const imageBuffers = images.map(async (elem) => {
        const dest = `src/public/${folderId}-${elem.id}.${elem.fileExtension || 'jpg'}`
        await DriveHandler.downloadToDisk(elem.id as string, dest)
        imgPaths.push(dest)
      })
      await Promise.all(imageBuffers)
      ImgPaths = [...ImgPaths, ...imgPaths]
      const outputPath = `src/public/result_${Date.now()}.pdf`
      const generatePDF = await pdfHandler.createPdfFromImages(
        imgPaths,
        outputPath
      )
      await DriveHandler.uploadAndGetLink(
        outputPath,
        'application/pdf',
        folder.fileId as string,
        folder.name as string
      )
      ImgPaths.push(outputPath);
      uploads.push(generatePDF)
    }
    await Promise.all(uploads)
    ImgPaths.forEach((elem) => {
      fs.unlink(elem, (err) => {
        if (err) console.log('Failded to delte file: ', elem, ' \n', err)
      })
    })
    parentPort?.postMessage({ status: 'success' })
  } catch (error: any) {
    parentPort?.postMessage({ status: 'error', error: error.message || error })
  }
}

run()
