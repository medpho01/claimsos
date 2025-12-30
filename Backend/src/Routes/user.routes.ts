import { Router } from "express";

const router = Router();

router.route("/getUser/:userid").get();

export default router;