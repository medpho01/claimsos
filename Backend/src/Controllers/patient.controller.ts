
import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import { getIndianTimeISO } from '../Utils/indianTime.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import fileName from '../Utils/fileName.util.js'
import driveHandler from '../Services/driveUploader.service.js'

const FileName = new fileName();
const DriveHandler = new driveHandler();
class patientController {
    addPatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { firstName, lastName, phone, admittedAt } = req.body;
        const userId = req.user?.id;

        console.log('[ADD PATIENT] Request received:', { firstName, lastName, phone, userId });

        if (!userId) throw new apiError(401, "No user found please Log in again");

        // Use current timestamp if admittedAt is not provided
        const admissionDate = admittedAt || getIndianTimeISO();

        console.log('[ADD PATIENT] Creating Drive folder...');
        const folder = await DriveHandler.createFolder(FileName.patientFolderName(firstName, admissionDate), req.user.folder_id);
        console.log('[ADD PATIENT] Drive folder created:', folder.fileId);

        console.log('[ADD PATIENT] Inserting patient into database...');
        const patient = await pool.query("INSERT INTO PATIENTS (first_name,last_name,phone,admitted_at,hospital_id,folder_id) values ($1,$2,$3,$4,$5,$6) returning id,first_name,last_name,phone,admitted_at,folder_id",
            [firstName, lastName, phone, admissionDate, userId, folder.fileId]
        )

        if (patient.rowCount == 0) throw new apiError(500, "Server Error. Couldn't create new patient.");

        console.log('[ADD PATIENT] Patient created successfully:', patient.rows[0].id);

        res.status(201).json(new apiResponse(201, patient.rows[0], "Patient created successfully"));
    })

    getAllPatients = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.id;
        if (!userId) throw new apiError(401, "No user found please Log in again");

        const allPatients = await pool.query("select id,first_name,last_name,admitted_at,discharged_at,hospital_id,phone,folder_id from patients where hospital_id = $1", [userId]);
        res.status(200).json(new apiResponse(200, allPatients.rows, "successfully fetched all patients"));
    })
    updatePatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { firstName, lastName, phone, admittedAt } = req.body;
        const userId = req.user?.id;

        if (!userId || !admittedAt) throw new apiError(401, "No user found please Log in again");

        // Verify the patient belongs to this hospital
        const checkOwnership = await pool.query(
            "SELECT id FROM patients WHERE id = $1 AND hospital_id = $2",
            [id, userId]
        );

        if (checkOwnership.rowCount === 0) {
            throw new apiError(404, "Patient not found or unauthorized");
        }

        const updatedPatient = await pool.query(
            "UPDATE patients SET first_name = $1, last_name = $2, phone = $3, updated_at = NOW(), admitted_at = $5 WHERE id = $4 RETURNING id, first_name, last_name, phone, admitted_at, folder_id",
            [firstName, lastName, phone, id,admittedAt]
        );

        res.status(200).json(new apiResponse(200, updatedPatient.rows[0], "Patient updated successfully"));
    })

    dischargePatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { dischargedAt } = req.body;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        // Verify the patient belongs to this hospital
        const checkOwnership = await pool.query(
            "SELECT id FROM patients WHERE id = $1 AND hospital_id = $2",
            [id, userId]
        );

        if (checkOwnership.rowCount === 0) {
            throw new apiError(404, "Patient not found or unauthorized");
        }

        const updatedPatient = await pool.query(
            "UPDATE patients SET discharged_at = $1, updated_at = NOW() WHERE id = $2 RETURNING id, first_name, last_name, phone, admitted_at, discharged_at, folder_id",
            [dischargedAt, id]
        );

        res.status(200).json(new apiResponse(200, updatedPatient.rows[0], "Patient discharged successfully"));
    })

    deletePatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        // Verify the patient belongs to this hospital
        const checkOwnership = await pool.query(
            "SELECT id FROM patients WHERE id = $1 AND hospital_id = $2",
            [id, userId]
        );

        if (checkOwnership.rowCount === 0) {
            throw new apiError(404, "Patient not found or unauthorized");
        }

        // Hard delete - consider soft delete in production
        await pool.query("DELETE FROM patients WHERE id = $1", [id]);

        res.status(200).json(new apiResponse(200, null, "Patient deleted successfully"));
    })
}

export default patientController
