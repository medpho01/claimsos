import React, { createContext, useContext } from 'react';
import { Hospital, HospitalPanel, HospitalUser, User } from '../../../types';

interface HospitalDataContextType {
    hospital: Hospital | null;
    hospitalUsers: HospitalUser[];
    hospitalPanels: HospitalPanel[];
    loading: boolean;
    setHospitalUsers: React.Dispatch<React.SetStateAction<HospitalUser[]>>;
    setHospitalPanels: React.Dispatch<React.SetStateAction<HospitalPanel[]>>;
    refreshData: () => void; // Function to manually trigger a refresh if needed
}

const HospitalDataContext = createContext<HospitalDataContextType | undefined>(undefined);

export const useHospitalDataContext = () => {
    const context = useContext(HospitalDataContext);
    if (!context) {
        throw new Error('useHospitalDataContext must be used within a HospitalDataProvider');
    }
    return context;
};

interface HospitalDataProviderProps {
    children: React.ReactNode;
    value: HospitalDataContextType;
}

export const HospitalDataProvider: React.FC<HospitalDataProviderProps> = ({ children, value }) => {
    return (
        <HospitalDataContext.Provider value={value}>
            {children}
        </HospitalDataContext.Provider>
    );
};
