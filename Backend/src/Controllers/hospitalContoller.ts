import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import fileName from '../Utils/fileName.util.js'

const DriveHandler = new driveHandler()
const FileName = new fileName()

const rootId = process.env.GOOGLE_DRIVE_ROOT_ID as string

class hospitalController {
    addHospital = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id
            if (!adminId) throw new apiError(401, 'Unauthorized')

            const { name, city } = req.body

            if (!name || !city) throw new apiError(400, 'Provide name and city')

            const folder = await DriveHandler.createFolder(
                FileName.folderName(name),
                rootId
            )

            if(!folder.fileId)throw new apiError(500,"Couldn't create drive folder");

            const hospitalRes = await pool.query(
                'insert into hospitals (name,city,drive_folder_id) values ($1,$2,$3) returning id',
                [name, city, folder.fileId]
            )

            if (hospitalRes.rowCount == 0)
                throw new apiError(
                    500,
                    'Somethng went wront while creating the hospital please try again'
                )

            res.status(201).json(
                new apiResponse(
                    201,
                    hospitalRes.rows[0],
                    'Successfully added hospital'
                )
            )
        }
    )

    getAllHospitals = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id
            if (!adminId) throw new apiError(401, 'Unauthorized')
            const hospitalRes = await pool.query(
                'Select id,name,city from hospitals'
            )
            res.status(200).json(
                new apiResponse(
                    200,
                    hospitalRes.rows,
                    'Successfully fetched all hospitals'
                )
            )
        }
    )

    getHospitalsByAdmin = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.params?.adminId || req.user?.id

            if (!adminId) throw new apiError(400, 'admin id is required')

            const hospitalResult = await pool.query(
                'SELECT hospital_id FROM hospital_assignments WHERE admin_id = $1',
                [adminId]
            )
            
            const hospitalIds = hospitalResult.rows.map((elem) => elem.hospital_id)
            const hospitalRes = await pool.query(
                'select id,name,city from hospitals where id = ANY($1)',
                [hospitalIds]
            )
            const hospitals = hospitalRes.rows;
            res.status(200).json(
                new apiResponse(
                    200,
                    hospitals,
                    'Successfully fetched Hospitals info by admin'
                )
            )
        }
    )

    addPanel = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const {
                hospitalId,
                panelId,
                contact,
                sheetId,
                sheetName,
                whatsAppGroupId,
            } = req.body

            const hospitalRes = await pool.query(
                'select name,drive_folder_id from hospitals where id = $1',
                [hospitalId]
            )
            if (hospitalRes.rowCount == 0)
                throw new apiError(400, 'No such hospital exists')

            const panelRes = await pool.query(
                'select name from panels where id = $1',
                [panelId]
            )
            if (panelRes.rowCount == 0)
                throw new apiError(400, 'No such panel exists')

            const folder = await DriveHandler.createFolder(
                FileName.folderName(panelRes.rows[0].name),
                hospitalRes.rows[0].drive_folder_id
            )
            const panelLink = await pool.query(
                'insert into hospital_panels (hospital_id,panel_id,whatsapp_group_id,sheet_id,sheet_name,drive_folder_id,contact) values ($1,$2,$3,$4,$5,$6,$7) returning *',
                [
                    hospitalId,
                    panelId,
                    whatsAppGroupId,
                    sheetId,
                    sheetName,
                    folder?.fileId,
                    contact,
                ]
            )
            if (panelLink.rowCount == 0)throw new apiError(500,'Something went wrong while linking panel')
            res.status(201).json(new apiResponse(201,panelRes.rows[0],"Panel Linked successfully"))
        }
    )
}

export default hospitalController
