// A more complete upload function
import { google } from 'googleapis'
import { createReadStream } from 'fs'
import apiError from '../Utils/errorHandler.util.js'

export default class driveHandler {
  async uploadAndGetLink(
    imagePath: string,
    mimeType: string,
    parentForlderId:string,
    fileName: string = 'upload.txt'
  ) {
    if (parentForlderId) {
      console.log('PARENT FOLDER ID BEING USED:', parentForlderId)
    } else {
      throw new apiError(400,"Need parent folder id");
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    const fileMetadata = {
      name: fileName,
      parents: [parentForlderId],
    }

    const media = {
      mimeType: mimeType,
      body: createReadStream(imagePath),
    }

    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id',
      supportsAllDrives: true,
    })

    const fileId = file.data.id
    console.log(`File Uploaded: ${fileName}, ID: ${fileId}`)

    await drive.permissions.create({
      fileId: fileId || '',
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true,
    })

    const links = {
      shareLink: `https://drive.google.com/file/d/${fileId}/view`,
      directLink: `https://drive.google.com/uc?id=${fileId}`,
    }
    return links
  }

  async createFolder(
    folderName: string,
    parentForlderId:string
  ) {
    if (parentForlderId) {
      console.log('PARENT FOLDER ID BEING USED:', parentForlderId)
    } else {
      throw new apiError(400,"Need parent folder id");
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    const fileMetadata = {
      name: folderName,
      parents: [parentForlderId],
      mimeType: "application/vnd.google-apps.folder",
    }

    const file = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id',
      supportsAllDrives: true,
    })

    const fileId = file.data.id

    const links = {
      shareLink: `https://drive.google.com/file/d/${fileId}/view`,
      directLink: `https://drive.google.com/uc?id=${fileId}`,
      fileId
    }
    return links
  }
}
