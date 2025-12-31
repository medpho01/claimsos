
import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import { getIndianTimeISO } from '../Utils/indianTime.util.js'
import apiResponse from '../Utils/apiResponse.util.js'

class patientController {
    addPatient = asyncHandler(async (req:Request,res:Response,next:NextFunction)=>{
        const {firstName,lastName,phone,admittedAt} = req.body;
        const userId = req.user?.id;
        if(!userId)throw new apiError(401,"No user found please Log in again");

        const patient = await pool.query("INSERT INTO PATIENTS (first_name,last_name,phone,admitted_at,hospital_id) values ($1,$2,$3,$4,$5) returning id,first_name,last_name,phone,admitted_at",
            [firstName,lastName,phone,admittedAt,userId]
        )

        if(patient.rowCount == 0)throw new apiError(500,"Server Error. Couldn't create new patient.");

        res.status(201).json(new apiResponse(200,patient.rows[0],"Patient created successfully"));
    })

    getAllPatients = asyncHandler(async(req:Request,res:Response,next:NextFunction)=>{
        const userId = req.user?.id;
        if(!userId)throw new apiError(401,"No user found please Log in again");

        const allPatients = await pool.query("select id,first_name,last_name,admitted_at,hospital_id,phone from patients where hospital_id = $1",[userId]);
        res.status(200).json(new apiResponse(200,allPatients.rows,"successfully fetched all patients"));
    })
}

export default patientController
