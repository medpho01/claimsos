import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'

const SECRET_TOKEN = process.env.GOOGLE_SHEET_SECRET_TOKEN
const sheetURL = process.env.GOOGLE_SHEET_WEBHOOK_URL
class claimsController {
  addClaim = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const {
        patientId,
        treatmentPlan,
        latestStatus,
        claimAmount,
        claimApproved,
        incentive,
        deduction,
        deductionReason,
        claimSettled,
        claimSettledDate,
      } = req.body
      if (!patientId) throw new apiError(400, 'PatietId is required')
      const claimRes = await pool.query(
        'select * from claims where ipd_id = $1',
        [patientId]
      )
      let response;
      if (claimRes.rowCount == 0) {
        response = await pool.query(
          'insert into claims (ipd_id,treatment_plan,latest_status,claim_amount,claim_approved,incentive,deduction,deduction_reason,claim_settled,claim_settled_date) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ipd_id',
          [
            patientId,
            treatmentPlan,
            latestStatus,
            claimAmount,
            claimApproved,
            incentive,
            deduction,
            deductionReason,
            claimSettled,
            claimSettledDate,
          ]
        )
      } else {
        response = await pool.query(
          'update claims set treatment_plan = $1,latest_status=$2,claim_amount=$3,claim_approved=$4,incentive=$5,deduction=$6,deduction_reason=$7,claim_settled=$8,claim_settled_date=$9 where ipd_id = $10 returning ipd_id',
          [
            treatmentPlan,
            latestStatus,
            claimAmount,
            claimApproved,
            incentive,
            deduction,
            deductionReason,
            claimSettled,
            claimSettledDate,
            patientId,
          ]
        )
      }


      if (response.rowCount == 0) {
        throw new apiError(500, 'Couldnt update the claim')
      }

      const sheetRes = await pool.query(
        'select hp.sheet_id,hp.sheet_name from ipds as p join hospital_panels as hp on p.hospital_panel_id = hp.id where p.id = $1',
        [patientId]
      )
      const sheetID = sheetRes.rows[0]?.sheet_id;
      const sheetName = sheetRes.rows[0]?.sheet_name;
      if (sheetID && sheetURL) {
        const sheetData = {
          id: patientId,
          treatment_procedure: treatmentPlan,         
          latest_status: latestStatus, 
          claim_amount: claimAmount,        
          secret: SECRET_TOKEN,
          sheet_id: sheetID,
          sheet_name: sheetName,
          action: 'update',
        }
        const response = await fetch(sheetURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(sheetData),
          redirect: 'follow',
        })
      }
      res.status(201).json(new apiResponse(201,response.rows[0],"Successfully updated the claim"));
    }
  )
}

export default claimsController
