import { google } from 'googleapis'
import { createReadStream } from 'fs'
import apiError from '../Utils/errorHandler.util.js'
import fs from 'fs'

const fieldNames: Record<string, string> = {
  discharge_slip: 'Discharge Slip',
  investigations: 'Investigations',
  treatment: 'Treatment',
  icps: 'ICPs',
  surgical_discharge_slip: 'Surgical Discharge Slip',
  ot_notes_and_photos: 'OT Notes and Photos',
  post_op_photos: 'Post Op Photos',
  post_op_reports: 'Post Op Reports',
  implant_invoice: 'Implant Invoice',
  others: 'Others',
}

export default class driveHandler {
  getImageCounts = async (folderId: string) => {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })

      const folders = res.data.files || []

      const subFolderCounts = await Promise.all(
        folders.map(async (subFolder) => {
          const res = await drive.files.list({
            q: `'${subFolder.id}' in parents and (mimeType contains 'image/' or mimeType = 'application/pdf') and trashed = false`,
            fields: 'files(id)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          })
          return {
            id: subFolder.id,
            name: subFolder.name || '',
            count: res.data.files?.length || 0,
          }
        })
      )
      const counts: Record<string, number> = {}
      subFolderCounts.forEach((elem) => {
        const field = fieldNames[elem['name']] as string
        counts[field] = elem['count']
      })
      return counts
    } catch (error) {
      console.error(`Error processing folder ${folderId}:`, error)
      return 0
    }
  }

  async uploadAndGetLink(
    imagePath: string,
    mimeType: string,
    parentForlderId: string,
    fileName: string = 'upload.txt'
  ) {
    if (parentForlderId) {
      console.log('PARENT FOLDER ID BEING USED:', parentForlderId)
    } else {
      throw new apiError(400, 'Need parent folder id')
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

  async createFolder(folderName: string, parentForlderId: string) {
    if (parentForlderId) {
      console.log('PARENT FOLDER ID BEING USED:', parentForlderId)
    } else {
      throw new apiError(400, 'Need parent folder id')
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    const fileMetadata = {
      name: folderName,
      parents: [parentForlderId],
      mimeType: 'application/vnd.google-apps.folder',
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
      fileId,
    }
    return links
  }

  async listFiles(folderId: string) {
    if (!folderId) {
      throw new apiError(400, 'Need folder id')
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    const response = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType = 'application/pdf') and trashed = false`,
      fields:
        'files(id, name, mimeType, thumbnailLink, webViewLink, createdTime)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    return response.data.files || []
  }

  async listImages(folderId: string) {
    if (!folderId) {
      throw new apiError(400, 'Need folder id')
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    const response = await drive.files.list({
      q: `'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`,
      fields:
        'files(id, name, mimeType, thumbnailLink, webViewLink, createdTime)',
      orderBy: 'createdTime desc',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    return response.data.files || []
  }

  async deleteFile(fileId: string) {
    if (!fileId) {
      throw new apiError(400, 'Need file id')
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    try {
      // First, check if file exists and get its capabilities
      const fileCheck = await drive.files.get({
        fileId: fileId,
        fields: 'id,name,capabilities',
        supportsAllDrives: true,
      })

      const capabilities = fileCheck.data.capabilities as any
      if (capabilities && !capabilities.canDelete) {
        console.log(`[DELETE FILE] No delete permission for file ${fileId}`)
        throw new apiError(
          403,
          "You don't have permission to delete this file. Check Google Drive sharing settings."
        )
      }

      // Now delete the file
      await drive.files.delete({
        fileId: fileId,
        supportsAllDrives: true,
      })

      console.log(`[DELETE FILE] Successfully deleted file ${fileId}`)
      return { success: true }
    } catch (error: any) {
      if (error.code === 404 || error.status === 404) {
        console.log(`[DELETE FILE] File ${fileId} not found`)
        return { success: true, alreadyDeleted: true }
      }
      if (error.code === 403 || error.status === 403) {
        console.log(`[DELETE FILE] Permission denied for file ${fileId}`)
        throw new apiError(
          403,
          "Permission denied. The service account doesn't have delete access to this file."
        )
      }
      throw error
    }
  }

  getFolders = async (folderId: string) => {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })

    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      const folders = res.data.files?.map((elem) => {
        return { fileId: elem.id, name: elem.name }
      })
      return folders || []
    } catch (error) {
      console.error(`Error processing folder ${folderId}:`, error)
      return []
    }
  }
  getFileStream = async (fileId: string) => {
    const auth = new google.auth.GoogleAuth({
      keyFile: 'drive.json',
      scopes: ['https://www.googleapis.com/auth/drive'],
    })
    const drive = google.drive({ version: 'v3', auth })
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    )
    return res.data
  }
  downloadToDisk = async (fileId: string, destPath: string) => {
    const stream = await this.getFileStream(fileId);
    const writer = fs.createWriteStream(destPath);
    return new Promise((resolve, reject) => {
        stream.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
  }
}
