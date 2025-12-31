import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import fs from 'fs'

const DriveHandler = new driveHandler()

class uploadsController {
  upload = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const filesRaw = req.files as
        | Express.Multer.File[]
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined

      const files: Express.Multer.File[] = Array.isArray(filesRaw)
        ? filesRaw
        : Object.values(filesRaw ?? {}).flat()
      const { folderId } = req.body
      for (const file of files) {
        try {
          await DriveHandler.uploadAndGetLink(
            file?.path,
            file?.mimetype,
            folderId,
            file.filename
          )
          fs.unlink(file?.path, (err) => {
            if (err) throw new apiError(500, 'Couldnt delete the file')
          })
        } catch (error) {
          console.log(error)
        }
      }
      res.status(201).json({ data: req.files })
    }
  )
}

export default uploadsController
