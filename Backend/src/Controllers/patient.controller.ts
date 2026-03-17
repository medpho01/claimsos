import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import { getIndianTimeISO } from '../Utils/indianTime.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import fileName from '../Utils/fileName.util.js'
import driveHandler from '../Services/driveUploader.service.js'

const FileName = new fileName()
const DriveHandler = new driveHandler()

const SECRET_TOKEN = process.env.GOOGLE_SHEET_SECRET_TOKEN
const sheetURL = process.env.GOOGLE_SHEET_WEBHOOK_URL
class ipdController {
  addPatient = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const {
        firstName,
        lastName,
        phone,
        admittedAt,
        hospitalId,
        panelId,
        admissionType,
      } = req.body
      let hospitalID = hospitalId
      const userId = req.user?.id
      const userRole = req.user?.role
      if (!panelId || !firstName || !admittedAt) {
        throw new apiError(400, 'Fill in all required details')
      }

      if (!userId) throw new apiError(401, 'No user found please Log in again')

      if (userRole == 'superadmin') {
        if (!hospitalId)
          throw new apiError(400, 'Hospital id is required for superadmin')
      } else if (userRole == 'admin') {
        if (!hospitalId)
          throw new apiError(400, 'Hospital id is required for admin')
        const adminRes = await pool.query(
          'select hospital_id,can_edit from hospital_assignments where admin_id = $1 and hospital_id = $2',
          [userId, hospitalID]
        )
        if (adminRes.rowCount == 0 || !adminRes.rows[0].can_edit)
          throw new apiError(401, 'Not authorized')
      } else if (userRole == 'hospital') {
        // Check if user has access to this panel (either specific panel or 'admin' role)
        const hospitalRes = await pool.query(
          `select hospital_id from hospital_users where user_id = $1 and ($2 = ANY(role) OR 'admin' = ANY(role))`,
          [userId, panelId]
        )
        if (hospitalRes.rowCount == 0)
          throw new apiError(401, 'Not authorized')
        hospitalID = hospitalRes.rows[0].hospital_id
      }

      console.log('[ADD PATIENT] Request received:', {
        firstName,
        lastName,
        phone,
        userId,
        role: userRole,
        hospitalID,
      })

      // Use current timestamp if admittedAt is not provided
      const admissionDate = admittedAt || getIndianTimeISO()

      console.log('[ADD PATIENT] Creating Drive folder...')

      // Get the hospital's drive_folder_id for creating patient subfolder
      const panelRes = await pool.query(
        'select drive_folder_id,id,sheet_name,sheet_id from hospital_panels where hospital_id = $1 and panel_id = $2',
        [hospitalID, panelId]
      )
      if (panelRes.rowCount == 0)
        throw new apiError(400, 'Create this panel for hospital first')

      const folderParentId = panelRes.rows[0].drive_folder_id

      const sheetID = panelRes.rows[0].sheet_id
      const sheetName = panelRes.rows[0].sheet_name

      const folder = await DriveHandler.createFolder(
        FileName.patientFolderName(firstName, admissionDate),
        folderParentId
      )
      console.log('[ADD PATIENT] Drive folder created:', folder.fileId)

      console.log('[ADD PATIENT] Inserting patient into database...')
      const patient = await pool.query(
        'INSERT INTO IPDS (first_name,last_name,phone,admitted_at,hospital_id,drive_folder_id,admission_type,panel_id,hospital_panel_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,first_name,last_name,phone,admitted_at,drive_folder_id,admission_type,panel_id',
        [
          firstName,
          lastName,
          phone,
          admissionDate,
          hospitalID,
          folder.fileId,
          admissionType,
          panelId,
          panelRes.rows[0].id,
        ]
      )

      if (patient.rowCount == 0)
        throw new apiError(500, "Server Error. Couldn't create new patient.")
      let admitted_at = admissionDate?.split(' ')[0]
      admitted_at = admissionDate?.split('T')[0]

      if (sheetID && sheetURL) {
        const sheetData = {
          first_name: firstName,
          lastName: lastName,
          phone: phone,
          admitted_at: admittedAt?.split(' ')[0],
          id: patient.rows[0].id,
          secret: SECRET_TOKEN,
          sheet_id: sheetID,
          sheet_name: sheetName,
          action: 'add',
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

      console.log(
        '[ADD PATIENT] Patient created successfully:',
        patient.rows[0].id
      )

      res
        .status(201)
        .json(
          new apiResponse(201, patient.rows[0], 'Patient created successfully')
        )
    }
  )

  getAllPatients = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role

      if (!userId) throw new apiError(401, 'No user found please Log in again')

      let allPatients

      // Superadmins see all patients
      if (userRole === 'superadmin') {
        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 LEFT JOIN users u ON p.hospital_id = u.id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 ORDER BY p.admitted_at DESC`
        )
      }
      // Admins see ipds from their assigned hospitals
      else if (userRole === 'admin') {
        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        ha.can_view, ha.can_edit, ha.can_discharge,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 JOIN users u ON p.hospital_id = u.id
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE ha.admin_id = $1
                 ORDER BY p.admitted_at DESC`,
          [userId]
        )
      }
      // Hospital users see only their own patients
      else {
        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        hu.role, pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                     FROM ipds as p 
                     JOIN hospital_users as hu ON p.hospital_id = hu.hospital_id 
                     LEFT JOIN panels pn ON p.panel_id = pn.id
                     LEFT JOIN claims c ON p.id = c.ipd_id
                     WHERE hu.user_id = $1 
                       AND ('admin' = ANY(hu.role) OR p.panel_id = ANY(hu.role::uuid[]))
                     ORDER BY admitted_at DESC`,
          [userId]
        )
      }
      res
        .status(200)
        .json(
          new apiResponse(
            200,
            allPatients.rows,
            'successfully fetched all patients'
          )
        )
    }
  )

  getAllPatientsPaginated = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role
      const page = parseInt(req.query?.page as string) || 1

      if (page < 1) throw new apiError(400, 'invalid page number')
      if (!userId) throw new apiError(401, 'No user found please Log in again')

      let allPatients
      let totalCounts

      // Superadmins see all patients
      if (userRole === 'superadmin') {
        totalCounts = await pool.query(`SELECT count(*) as total_count
                 FROM ipds p
                 LEFT JOIN users u ON p.hospital_id = u.id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id`)
        if (totalCounts.rowCount == 0)
          throw new apiError(500, 'Couldnt fetch the data from the DB')
        if ((totalCounts.rows[0].total_count + 20) / 20 < page)
          throw new apiError(400, 'invalid page number')
        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 LEFT JOIN users u ON p.hospital_id = u.id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 ORDER BY p.updated_at DESC,p.created_at DESC,p.id limit 20 offset $1`,
          [(page - 1) * 20]
        )
      }
      // Admins see ipds from their assigned hospitals
      else if (userRole === 'admin') {
        totalCounts = await pool.query(
          `SELECT count(*) as total_count
                 FROM ipds p
                 JOIN users u ON p.hospital_id = u.id
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE ha.admin_id = $1`,
          [userId]
        )
        if (totalCounts.rowCount == 0)
          throw new apiError(500, 'Couldnt fetch the data from the DB')
        if ((totalCounts.rows[0].total_count + 20) / 20 < page)
          throw new apiError(400, 'invalid page number')

        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        ha.can_view, ha.can_edit, ha.can_discharge,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 JOIN users u ON p.hospital_id = u.id
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE ha.admin_id = $1
                 ORDER BY p.updated_at DESC,p.created_at DESC,p.id limit 20 offset $2`,
          [userId, (page - 1) * 20]
        )
      } else {
        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        hu.role, pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                     FROM ipds as p 
                     JOIN hospital_users as hu ON p.hospital_id = hu.hospital_id 
                     LEFT JOIN panels pn ON p.panel_id = pn.id
                     LEFT JOIN claims c ON p.id = c.ipd_id
                     WHERE hu.user_id = $1 
                       AND ('admin' = ANY(hu.role) OR p.panel_id = ANY(hu.role::uuid[]))
                     ORDER BY admitted_at DESC`,
          [userId]
        )
      }
      res.status(200).json(
        new apiResponse(
          200,
          {
            data: allPatients.rows,
            meta: {
              totalCounts: parseInt(totalCounts?.rows[0].total_count),
              itemCounts: allPatients.rowCount,
              itemsPerPage: 20,
              totalPages: Math.ceil(
                parseInt(totalCounts?.rows[0].total_count) / 20
              ),
              currentPage: page,
            },
          },
          'successfully fetched all patients'
        )
      )
    }
  )

  getPanelPatientsPaginated = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role
      const page = parseInt(req.query?.page as string) || 1
      const panelId = (req.query?.panelId as string) || null
      const hospitalId = (req.query?.hospitalId as string) || null
      const status = (req.query?.status as string) || 'all'
      const search = (req.query?.search as string) || ''
      const ITEMS_PER_PAGE = 20

      if (page < 1) throw new apiError(400, 'invalid page number')
      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!hospitalId || !panelId)
        throw new apiError(400, 'Hospital and panel id required')

      // Build dynamic status filter clause
      let statusFilter = ''
      switch (status) {
        case 'active':
          statusFilter = ' AND p.is_active = true'
          break
        case 'admitted':
          statusFilter = ' AND p.is_active = true AND p.discharged_at IS NULL'
          break
        case 'discharged':
          statusFilter = ' AND p.is_active = true AND p.discharged_at IS NOT NULL'
          break
        case 'deactivated':
          statusFilter = ' AND p.is_active = false'
          break
        default:
          // 'all' - no extra filter
          statusFilter = ''
      }

      // Build search filter clause
      let searchFilter = ''
      const searchParams: string[] = []
      if (search.trim()) {
        const searchTerm = `%${search.trim()}%`
        searchParams.push(searchTerm)
        // The placeholder index will be appended dynamically below
        searchFilter = ` AND (p.first_name ILIKE '__SEARCH__' OR p.last_name ILIKE '__SEARCH__' OR p.phone ILIKE '__SEARCH__')`
      }

      let allPatients
      let totalCounts

      // Superadmins see all patients
      if (userRole === 'superadmin') {
        let paramIndex = 2
        let countParams: any[] = [hospitalId, panelId]
        let dataParams: any[] = [hospitalId, panelId]

        let dynamicSearchFilter = ''
        if (search.trim()) {
          paramIndex++
          dynamicSearchFilter = ` AND (p.first_name ILIKE $${paramIndex} OR p.last_name ILIKE $${paramIndex} OR p.phone ILIKE $${paramIndex})`
          countParams.push(`%${search.trim()}%`)
          dataParams.push(`%${search.trim()}%`)
        }

        totalCounts = await pool.query(
          `SELECT count(*) as total_count FROM ipds p WHERE p.hospital_id = $1 AND p.panel_id = $2${statusFilter}${dynamicSearchFilter}`,
          countParams
        )
        if (totalCounts.rowCount == 0)
          throw new apiError(500, 'Couldnt fetch the data from the DB')

        const totalCount = parseInt(totalCounts.rows[0].total_count)
        const totalPages = Math.max(1, Math.ceil(totalCount / ITEMS_PER_PAGE))

        const offsetParamIndex = paramIndex + 1
        dataParams.push((page - 1) * ITEMS_PER_PAGE)

        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        pn.name as panel_name, c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE p.hospital_id = $1 AND p.panel_id = $2${statusFilter}${dynamicSearchFilter}
                 ORDER BY p.updated_at DESC,p.created_at DESC,p.id LIMIT ${ITEMS_PER_PAGE} OFFSET $${offsetParamIndex}`,
          dataParams
        )
      }
      // Admins see ipds from their assigned hospitals
      else if (userRole === 'admin') {
        let paramIndex = 3
        let countParams: any[] = [userId, hospitalId, panelId]
        let dataParams: any[] = [userId, hospitalId, panelId]

        let dynamicSearchFilter = ''
        if (search.trim()) {
          paramIndex++
          dynamicSearchFilter = ` AND (p.first_name ILIKE $${paramIndex} OR p.last_name ILIKE $${paramIndex} OR p.phone ILIKE $${paramIndex})`
          countParams.push(`%${search.trim()}%`)
          dataParams.push(`%${search.trim()}%`)
        }

        totalCounts = await pool.query(
          `SELECT count(*) as total_count
                 FROM ipds p
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 WHERE ha.admin_id = $1 AND p.hospital_id = $2 AND p.panel_id = $3${statusFilter}${dynamicSearchFilter}`,
          countParams
        )
        if (totalCounts.rowCount == 0)
          throw new apiError(500, 'Couldnt fetch the data from the DB')

        const totalCount = parseInt(totalCounts.rows[0].total_count)
        const totalPages = Math.max(1, Math.ceil(totalCount / ITEMS_PER_PAGE))

        const offsetParamIndex = paramIndex + 1
        dataParams.push((page - 1) * ITEMS_PER_PAGE)

        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        ha.can_view, ha.can_edit, ha.can_discharge,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE ha.admin_id = $1 AND p.hospital_id = $2 AND p.panel_id = $3${statusFilter}${dynamicSearchFilter}
                 ORDER BY p.updated_at DESC,p.created_at DESC,p.id LIMIT ${ITEMS_PER_PAGE} OFFSET $${offsetParamIndex}`,
          dataParams
        )
      } else {
        // Hospital users
        // Verify hospital user has access to this panel (either specific panel or 'admin' role)
        const accessCheck = await pool.query(
          `SELECT 1 FROM hospital_users WHERE user_id = $1 AND hospital_id = $2 AND ($3 = ANY(role) OR 'admin' = ANY(role))`,
          [userId, hospitalId, panelId]
        );
        if (accessCheck.rowCount === 0) {
          throw new apiError(403, 'Forbidden. You do not have access to this panel.');
        }

        // Hospital users always see only active patients
        const hospitalStatusFilter = status === 'all' ? ' AND p.is_active = true' : statusFilter || ' AND p.is_active = true'

        let paramIndex = 3
        let countParams: any[] = [hospitalId, panelId]
        let dataParams: any[] = [userId, hospitalId, panelId]

        let dynamicSearchFilterCount = ''
        let dynamicSearchFilterData = ''
        if (search.trim()) {
          const countSearchIdx = 3
          dynamicSearchFilterCount = ` AND (p.first_name ILIKE $${countSearchIdx} OR p.last_name ILIKE $${countSearchIdx} OR p.phone ILIKE $${countSearchIdx})`
          countParams.push(`%${search.trim()}%`)

          paramIndex++
          dynamicSearchFilterData = ` AND (p.first_name ILIKE $${paramIndex} OR p.last_name ILIKE $${paramIndex} OR p.phone ILIKE $${paramIndex})`
          dataParams.push(`%${search.trim()}%`)
        }

        totalCounts = await pool.query(
          `SELECT count(*) as total_count FROM ipds p WHERE p.hospital_id = $1 AND p.panel_id = $2${hospitalStatusFilter}${dynamicSearchFilterCount}`,
          countParams
        );

        if (totalCounts.rowCount == 0)
          throw new apiError(500, 'Couldnt fetch the data from the DB')

        const totalCount = parseInt(totalCounts.rows[0].total_count)
        const totalPages = Math.max(1, Math.ceil(totalCount / ITEMS_PER_PAGE))

        const offsetParamIndex = paramIndex + 1
        dataParams.push((page - 1) * ITEMS_PER_PAGE)

        allPatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        hu.role, pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                     FROM ipds as p 
                     JOIN hospital_users as hu ON p.hospital_id = hu.hospital_id 
                     LEFT JOIN panels pn ON p.panel_id = pn.id
                     LEFT JOIN claims c ON p.id = c.ipd_id
                     WHERE hu.user_id = $1 AND p.hospital_id = $2 AND p.panel_id = $3${hospitalStatusFilter}${dynamicSearchFilterData}
                     ORDER BY p.updated_at DESC,p.created_at DESC,p.id LIMIT ${ITEMS_PER_PAGE} OFFSET $${offsetParamIndex}`,
          dataParams
        )
      }

      const totalCount = parseInt(totalCounts?.rows[0].total_count)
      res.status(200).json(
        new apiResponse(
          200,
          {
            data: allPatients.rows,
            meta: {
              totalCounts: totalCount,
              itemCounts: allPatients.rowCount,
              itemsPerPage: ITEMS_PER_PAGE,
              totalPages: Math.max(1, Math.ceil(totalCount / ITEMS_PER_PAGE)),
              currentPage: page,
            },
          },
          'successfully fetched all patients'
        )
      )
    }
  )

  getTabCounts = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role
      const panelId = (req.query?.panelId as string) || null
      const hospitalId = (req.query?.hospitalId as string) || null
      const search = (req.query?.search as string) || ''

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!hospitalId || !panelId)
        throw new apiError(400, 'Hospital and panel id required')

      let searchFilter = ''
      let params: any[] = [hospitalId, panelId]

      if (search.trim()) {
        searchFilter = ` AND (p.first_name ILIKE $3 OR p.last_name ILIKE $3 OR p.phone ILIKE $3)`
        params.push(`%${search.trim()}%`)
      }

      let baseWhere = ''

      if (userRole === 'superadmin') {
        baseWhere = `WHERE p.hospital_id = $1 AND p.panel_id = $2`
      } else if (userRole === 'admin') {
        baseWhere = `WHERE p.hospital_id = $1 AND p.panel_id = $2`
        // Verify admin has access
        const accessCheck = await pool.query(
          `SELECT 1 FROM hospital_assignments WHERE admin_id = $1 AND hospital_id = $2`,
          [userId, hospitalId]
        )
        if (accessCheck.rowCount === 0) {
          throw new apiError(403, 'Forbidden')
        }
      } else {
        // Hospital users - only count active patients
        const accessCheck = await pool.query(
          `SELECT 1 FROM hospital_users WHERE user_id = $1 AND hospital_id = $2 AND ($3 = ANY(role) OR 'admin' = ANY(role))`,
          [userId, hospitalId, panelId]
        )
        if (accessCheck.rowCount === 0) {
          throw new apiError(403, 'Forbidden')
        }
        baseWhere = `WHERE p.hospital_id = $1 AND p.panel_id = $2`
      }

      const result = await pool.query(
        `SELECT 
          COUNT(*) as all,
          COUNT(*) FILTER (WHERE p.is_active = true) as active,
          COUNT(*) FILTER (WHERE p.is_active = true AND p.discharged_at IS NULL) as admitted,
          COUNT(*) FILTER (WHERE p.is_active = true AND p.discharged_at IS NOT NULL) as discharged,
          COUNT(*) FILTER (WHERE p.is_active = false) as deactivated
         FROM ipds p
         ${baseWhere}${searchFilter}`,
        params
      )

      res.status(200).json(
        new apiResponse(200, result.rows[0], 'Tab counts fetched successfully')
      )
    }
  )

  getActivePatients = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role

      if (!userId) throw new apiError(401, 'No user found please Log in again')

      let activePatients

      // Superadmins see all patients
      if (userRole === 'superadmin') {
        activePatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 LEFT JOIN users u ON p.hospital_id = u.id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE p.is_active = true
                 ORDER BY p.admitted_at DESC`
        )
      }
      // Admins see ipds from their assigned hospitals
      else if (userRole === 'admin') {
        activePatients = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        ha.can_view, ha.can_edit, ha.can_discharge,
                        pn.name as panel_name,
                        c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, c.incentive, c.deduction, c.deduction_reason, c.claim_settled, c.claim_settled_date
                 FROM ipds p
                 JOIN users u ON p.hospital_id = u.id
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 LEFT JOIN panels pn ON p.panel_id = pn.id
                 LEFT JOIN claims c ON p.id = c.ipd_id
                 WHERE ha.admin_id = $1 AND p.is_active = true
                 ORDER BY p.admitted_at DESC`,
          [userId]
        )
      }
      // Hospital users see only their own patients
      else {
        activePatients = await pool.query(
          `SELECT 
          p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.drive_folder_id, p.admission_type, 
          p.is_active, p.panel_id, p.beneficiary_id, p.updated_at,
          hu.role, pn.name as panel_name,
          c.treatment_plan, c.latest_status, c.claim_amount, c.claim_approved, 
          c.incentive, c.deduction, c.deduction_reason, c.claim_settled, 
          c.claim_settled_date
          FROM ipds as p 
          JOIN hospital_users as hu ON p.hospital_id = hu.hospital_id 
          LEFT JOIN panels pn ON p.panel_id = pn.id
          LEFT JOIN claims c ON p.id = c.ipd_id
          WHERE hu.user_id = $1 
            AND p.is_active = true 
            AND p.panel_id = ANY(hu.role::uuid[]) 
          ORDER BY admitted_at DESC`,
          [userId]
        )
      }

      res
        .status(200)
        .json(
          new apiResponse(
            200,
            activePatients.rows,
            'successfully fetched active patients'
          )
        )
    }
  )

  updatePatientDetails = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const id = req.params.id || req.body.id
      const {
        firstName,
        lastName,
        phone,
        admittedAt,
        admissionType,
        beneficiaryId,
        hospitalId,
        // Claims fields
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
      console.log(req.body)
      const userId = req.user?.id
      if (!userId) throw new apiError(401, 'No user found please Log in again')

      const userRole = req.user?.role
      let admitted_at =
        admittedAt?.split('T')[0] || admittedAt?.split(' ')[0] || null
      const patientRes = await pool.query(
        'select p.panel_id,p.hospital_id,p.hospital_panel_id,hp.sheet_id,hp.sheet_name from ipds as p left join hospital_panels as hp on p.panel_id = hp.panel_id and p.hospital_id = hp.hospital_id where p.id = $1',
        [id]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(400, 'No patient with given information exists')

      const sheetID = patientRes.rows[0].sheet_id
      const sheetName = patientRes.rows[0].sheet_name

      // Role-based authorization
      if (userRole === 'hospital') {
        const hospitalRes = await pool.query(
          'select hospital_id,role from hospital_users where user_id = $1',
          [userId]
        )
        if (hospitalRes.rowCount == 0)
          throw new apiError(403, 'Forbidden. No associated hospital')
        if (
          patientRes.rows[0].hospital_id == hospitalRes.rows[0].hospital_id &&
          hospitalRes.rows[0].role.includes(patientRes.rows[0].panel_id)
        ) {
          const updatedPatient = await pool.query(
            `UPDATE ipds SET 
                        first_name = $1, 
                        last_name = $2, 
                        updated_at = NOW(), 
                        admitted_at = $3
                        WHERE id = $4 
                        RETURNING id, first_name, last_name, admitted_at, drive_folder_id, admission_type, hospital_id, panel_id`,
            [firstName, lastName, admittedAt, id]
          )

          if (sheetID && sheetURL) {
            const sheetData = {
              first_name: firstName,
              last_name: lastName,
              admitted_at: admitted_at,
              id: updatedPatient.rows[0].id,
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
          res
            .status(200)
            .json(
              new apiResponse(
                200,
                updatedPatient.rows[0],
                'Patient updated successfully'
              )
            )
          return
        }
      } else if (userRole === 'admin') {
        // Admins are already checked by middleware for 'can_edit' permission on this patient's hospital
        // But we double check existence
        const patientExists = await pool.query(
          'SELECT id FROM ipds WHERE id = $1',
          [id]
        )
        if (patientExists.rowCount === 0)
          throw new apiError(404, 'Patient not found')
      } else if (userRole === 'superadmin') {
        // Superadmin can edit anyone
        const patientExists = await pool.query(
          'SELECT id FROM ipds WHERE id = $1',
          [id]
        )
        if (patientExists.rowCount === 0)
          throw new apiError(404, 'Patient not found')
      }

      const updatedPatient = await pool.query(
        `UPDATE ipds SET 
                first_name = $1, 
                last_name = $2, 
                phone = $3, 
                updated_at = NOW(), 
                admitted_at = COALESCE($5, admitted_at), 
                admission_type = COALESCE($6, admission_type),
                beneficiary_id = $7
             WHERE id = $4 
             RETURNING id, first_name, last_name, phone, admitted_at, drive_folder_id, admission_type, discharged_at, hospital_id, panel_id, beneficiary_id`,
        [
          firstName,
          lastName,
          phone,
          id,
          admittedAt || null,
          admissionType || null,
          beneficiaryId !== undefined ? beneficiaryId : null,
        ]
      )
      if (updatedPatient.rowCount == 0)
        throw new apiError(500, 'Some error occured while updating the patient')

      // Upsert claims data if any claims field is provided
      // Check if any field is NOT undefined
      const claimsFields = [
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

      const hasClaimsData = claimsFields.some((field) => field !== undefined)

      console.log(
        '[UPDATE PATIENT] Has claims data:',
        hasClaimsData,
        claimsFields
      )

      if (hasClaimsData) {
        console.log('[UPDATE PATIENT] Upserting claims for patient:', id)
        try {
          await pool.query(
            `INSERT INTO claims (ipd_id, treatment_plan, latest_status, claim_amount, claim_approved, incentive, deduction, deduction_reason, claim_settled, claim_settled_date)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ON CONFLICT (ipd_id) 
                        DO UPDATE SET 
                            treatment_plan = COALESCE($2, claims.treatment_plan),
                            latest_status = COALESCE($3, claims.latest_status),
                            claim_amount = COALESCE($4, claims.claim_amount),
                            claim_approved = COALESCE($5, claims.claim_approved),
                            incentive = COALESCE($6, claims.incentive),
                            deduction = COALESCE($7, claims.deduction),
                            deduction_reason = COALESCE($8, claims.deduction_reason),
                            claim_settled = COALESCE($9, claims.claim_settled),
                            claim_settled_date = COALESCE($10, claims.claim_settled_date),
                            updated_at = NOW()`,
            [
              id,
              treatmentPlan !== undefined ? treatmentPlan : null,
              latestStatus !== undefined ? latestStatus : null,
              claimAmount !== undefined
                ? claimAmount === ''
                  ? null
                  : parseFloat(claimAmount)
                : null,
              claimApproved !== undefined
                ? claimApproved === ''
                  ? null
                  : parseFloat(claimApproved)
                : null,
              incentive !== undefined
                ? incentive === ''
                  ? null
                  : parseFloat(incentive)
                : null,
              deduction !== undefined
                ? deduction === ''
                  ? null
                  : parseFloat(deduction)
                : null,
              deductionReason !== undefined ? deductionReason : null,
              claimSettled !== undefined
                ? claimSettled === ''
                  ? null
                  : parseFloat(claimSettled)
                : null,
              claimSettledDate !== undefined ? claimSettledDate : null,
            ]
          )
          console.log('[UPDATE PATIENT] Claims upsert successful')
        } catch (err) {
          console.error('[UPDATE PATIENT] Error upserting claims:', err)
          // Don't throw here to ensure patient update success is returned
        }
      }

      // Sheet info already retrieved from patientRes query (lines 311-312)
      if (sheetID && sheetURL) {
        const sheetData = {
          first_name: firstName,
          last_name: lastName,
          phone: phone,
          admitted_at: admitted_at,
          id: updatedPatient.rows[0].id,
          treatment_procedure: treatmentPlan,
          latest_status: latestStatus,
          claim_amount: claimAmount,
          secret: SECRET_TOKEN,
          sheet_id: sheetID,
          sheet_name: sheetName,
          admission_type: admissionType,
          pmjay_case_number: beneficiaryId || null,
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

      res
        .status(200)
        .json(
          new apiResponse(
            200,
            updatedPatient.rows[0],
            'Patient updated successfully'
          )
        )
    }
  )

  dischargePatient = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { id } = req.params
      const { dischargedAt } = req.body
      const userId = req.user?.id
      const userRole = req.user?.role
      if (!userId) throw new apiError(401, 'No user found please Log in again')

      console.log('[DISCHARGE PATIENT] Request received:', {
        patientId: id,
        dischargedAt,
        userId,
        userRole,
      })

      const patientRes = await pool.query(
        'select p.panel_id,p.hospital_id,p.hospital_panel_id,hp.sheet_id,hp,sheet_name from ipds as p join hospital_panels as hp on p.panel_id = hp.panel_id and p.hospital_id = hp.hospital_id where p.id = $1',
        [id]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(400, 'No patient with given information exists')

      const sheetID = patientRes.rows[0].sheet_id
      const sheetName = patientRes.rows[0].sheet_name

      const patientExists = await pool.query(
        'SELECT id FROM ipds WHERE id = $1',
        [id]
      )
      if (patientExists.rowCount === 0)
        throw new apiError(404, 'Patient not found')

      const updatedPatient = await pool.query(
        'UPDATE ipds SET discharged_at = $1, updated_at = NOW() WHERE id = $2 RETURNING id, first_name, last_name, phone, admitted_at, discharged_at, drive_folder_id, hospital_id, panel_id, admission_type, is_active',
        [dischargedAt, id]
      )
      if (updatedPatient.rowCount == 0)
        throw new apiError(500, 'Some error occured while updating the patient')

      let discharged_at = dischargedAt?.split(' ')[0]
      discharged_at = discharged_at?.split('T')[0] || null
      if (sheetID && sheetURL) {
        const sheetData = {
          id: updatedPatient.rows[0].id,
          secret: SECRET_TOKEN,
          sheet_id: sheetID,
          sheet_name: sheetName,
          discharged_at: discharged_at,
          action: 'discharge',
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
      console.log('[DISCHARGE PATIENT] Patient discharged successfully:', {
        patientId: updatedPatient.rows[0].id,
        patientName: `${updatedPatient.rows[0].first_name} ${updatedPatient.rows[0].last_name}`,
        dischargedAt: updatedPatient.rows[0].discharged_at,
        userId,
        userRole,
      })
      res
        .status(200)
        .json(
          new apiResponse(
            200,
            updatedPatient.rows[0],
            'Patient discharged successfully'
          )
        )
    }
  )

  deletePatient = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { id } = req.params
      const userId = req.user?.id

      if (!userId) throw new apiError(401, 'No user found please Log in again')

      // Verify the patient belongs to this hospital
      const checkOwnership = await pool.query(
        'SELECT id FROM ipds WHERE id = $1 AND hospital_id = $2',
        [id, userId]
      )

      if (checkOwnership.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }

      // Hard delete - consider soft delete in production
      await pool.query('DELETE FROM ipds WHERE id = $1', [id])

      res
        .status(200)
        .json(new apiResponse(200, null, 'Patient deleted successfully'))
    }
  )

  togglePatientActiveStatus = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { id } = req.params
      const { isActive } = req.body
      const userId = req.user?.id
      const userRole = req.user?.role

      if (!userId) throw new apiError(401, 'No user found please Log in again')

      console.log('[TOGGLE PATIENT ACTIVE] Request received:', {
        patientId: id,
        requestedStatus: isActive,
        userId,
        userRole,
      })

      // Validate isActive is provided
      if (typeof isActive !== 'boolean') {
        throw new apiError(400, 'isActive must be a boolean value')
      }

      // Check if patient exists and get their hospital_id
      const patientCheck = await pool.query(
        'SELECT id, hospital_id, is_active FROM ipds WHERE id = $1',
        [id]
      )

      if (patientCheck.rowCount === 0) {
        throw new apiError(404, 'Patient not found')
      }

      const patient = patientCheck.rows[0]

      // Role-based authorization - only admin and superadmin can toggle
      if (userRole === 'hospital') {
        // Hospital users cannot toggle patient active status
        throw new apiError(
          403,
          'Unauthorized: Only admins can modify patient active status'
        )
      } else if (userRole === 'admin') {
        // Admins can toggle ipds from their assigned hospitals
        const permissionCheck = await pool.query(
          `SELECT can_edit FROM hospital_assignments 
                 WHERE admin_id = $1 AND hospital_id = $2 AND is_active = true`,
          [userId, patient.hospital_id]
        )

        if (
          permissionCheck.rowCount === 0 ||
          !permissionCheck.rows[0].can_edit
        ) {
          throw new apiError(
            403,
            'Unauthorized: You do not have permission to modify this patient'
          )
        }
      }
      // Superadmins can toggle any patient - no additional check needed

      // Update the is_active status
      const updatedPatient = await pool.query(
        `UPDATE ipds 
             SET is_active = $1, updated_at = NOW() 
             WHERE id = $2 
             RETURNING id, first_name, last_name, phone, admitted_at, discharged_at, drive_folder_id, admission_type, is_active, panel_id, hospital_id`,
        [isActive, id]
      )

      console.log(
        '[TOGGLE PATIENT ACTIVE] Patient status updated successfully:',
        {
          patientId: updatedPatient.rows[0].id,
          patientName: `${updatedPatient.rows[0].first_name} ${updatedPatient.rows[0].last_name}`,
          previousStatus: patient.is_active,
          newStatus: isActive,
          userId,
          userRole,
        }
      )

      res
        .status(200)
        .json(
          new apiResponse(
            200,
            updatedPatient.rows[0],
            `Patient ${isActive ? 'activated' : 'deactivated'} successfully`
          )
        )
    }
  )
}

export default ipdController
