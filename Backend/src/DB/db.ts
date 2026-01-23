import {Pool} from "pg"
import 'dotenv/config'
import apiError from "../Utils/errorHandler.util.js";

const sslConfig = process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined;

const pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: parseInt(process.env.POSTGRES_PORT || " "),
    options: `-c search_path=hospital`,
    ssl: sslConfig
});

const connectDB = async () => {
    try {
        pool.connect((err: Error | undefined, client: any, release: () => void) => {
            if (err) {
                return console.error("Error acquiring client", err.stack);
            }
            console.log("Successfully connected to PostgreSQL database!");
            release();
        });
    } catch (error) {
        console.error("ERROR: ", error);
        throw new apiError(500, "Couldn't connect to the DB");
    }
};

export { connectDB, pool };