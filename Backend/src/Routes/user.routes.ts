import { Router } from "express";

const router = Router();

router.route("/getUser/:userid").get((req,res,next)=>{res.status(200).json({})});

export default router;