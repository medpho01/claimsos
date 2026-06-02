import React from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useHospitalDataContext } from "../../hospital/context/HospitalDataContext";
import HospitalUserList from "../../superadmin/HospitalDetailsPage/components/HospitalUserList";
import { motion } from "framer-motion";

const HospitalUsersPage: React.FC = () => {
    const { user } = useAuth();
    const {
        hospital,
        hospitalUsers,
        hospitalPanels,
        loading,
        setHospitalUsers
    } = useHospitalDataContext();

    if (!hospital) return null;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-[1600px] mx-auto p-6 lg:p-10 space-y-6"
        >

            <HospitalUserList
                panels={hospitalPanels}
                users={hospitalUsers}
                loading={loading}
                user={user}
                hospital={hospital}
                onAddUser={() => { }}
                onUserClick={() => { }}
                onUserUpdate={(updatedUser) => {
                    setHospitalUsers(prev => prev.map(u => u.user_id === updatedUser.user_id ? updatedUser : u));
                }}
            />
        </motion.div>
    );
};

export default HospitalUsersPage;
