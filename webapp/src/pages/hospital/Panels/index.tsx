import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useHospitalDataContext } from "../../hospital/context/HospitalDataContext";
import PanelsList from "../../superadmin/HospitalDetailsPage/components/PanelsList";
import { motion } from "framer-motion";

const HospitalPanelsPage: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();
    const {
        hospital,
        hospitalPanels,
        loading,
    } = useHospitalDataContext();

    if (!hospital) return null;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-[1600px] mx-auto p-6 lg:p-10 space-y-6"
        >

            <PanelsList
                hospitalPanels={hospitalPanels}
                loading={loading}
                user={user}
                hospital={hospital}
                onPanelSelect={(panel) => navigate(`/portal/${hospitalId}/panel/${panel.id}`)}
                onLinkPanel={() => { }}
                hideDrive={true}
            />
        </motion.div>
    );
};

export default HospitalPanelsPage;
