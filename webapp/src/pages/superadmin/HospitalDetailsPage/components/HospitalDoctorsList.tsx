import React, { useState } from "react";
import apiService from "../../../../services/api";
import { Doctor } from "../../../../types";
import { toast } from "sonner";
import { Loader2, Plus, UserCircle2, Settings, Trash2, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import AddDoctorModal from "./AddDoctorModal";
import { DoctorDetailsModal } from "./DoctorDetailsModal";

interface HospitalDoctorsListProps {
    hospitalId: string;
    doctors: Doctor[];
    loading: boolean;
    onRefresh: () => void;
}

export const HospitalDoctorsList: React.FC<HospitalDoctorsListProps> = ({
    hospitalId,
    doctors,
    loading,
    onRefresh
}) => {
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    
    // Details Modal State
    const [selectedDoctorForDetails, setSelectedDoctorForDetails] = useState<Doctor | null>(null);

    const handleAddSubmit = async (data: any) => {
        setIsSubmitting(true);
        try {
            await apiService.addDoctor({ ...data, hospitalId });
            toast.success("Doctor added successfully");
            onRefresh();
            setIsAddModalOpen(false);
        } catch (error: any) {
            toast.error(error.response?.data?.message || "Failed to add doctor");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDeleteDoctor = async (e: React.MouseEvent, doctorId: string) => {
        e.stopPropagation(); // Prevent opening the modal when clicking delete
        if (!window.confirm("Are you sure you want to delete this doctor? All their documents will also be deleted.")) {
            return;
        }
        try {
            await apiService.deleteDoctor(doctorId);
            toast.success("Doctor deleted successfully");
            onRefresh();
        } catch (error: any) {
             toast.error(error.response?.data?.message || "Failed to delete doctor");
        }
    };

    if (loading) {
        return (
            <Card>
                <CardContent className="p-6 flex items-center justify-center min-h-[400px]">
                    <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardContent className="p-6">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg">
                            <UserCircle2 className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                                Doctors
                                <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-xs font-normal">
                                    {doctors.length}
                                </Badge>
                            </h3>
                        </div>
                    </div>
                    <Button onClick={() => setIsAddModalOpen(true)} className="gap-2 bg-indigo-600 hover:bg-indigo-700">
                        <Plus className="h-4 w-4" /> Add Doctor
                    </Button>
                </div>

                {doctors.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                        <div className="h-16 w-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                            <UserCircle2 className="h-8 w-8 text-slate-400" />
                        </div>
                        <h4 className="text-lg font-medium text-slate-900 mb-2">No doctors found</h4>                        
                        <Button onClick={() => setIsAddModalOpen(true)} variant="outline" className="gap-2">
                            <Plus className="h-4 w-4" /> Add First Doctor
                        </Button>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {doctors.map(doctor => (
                            <div 
                                key={doctor.id} 
                                onClick={() => setSelectedDoctorForDetails(doctor)}
                                className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-lg hover:border-indigo-300 transition-all cursor-pointer group flex flex-col h-full"
                            >
                                <div className="p-6 flex-1 flex flex-col items-center text-center relative">
                                    <button 
                                        onClick={(e) => handleDeleteDoctor(e, doctor.id)}
                                        className="absolute top-4 right-4 p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors opacity-0 group-hover:opacity-100"
                                        title="Delete Doctor"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>

                                    <div className="h-20 w-20 rounded-full bg-gradient-to-br from-indigo-100 to-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-2xl mb-4 shadow-inner">
                                        {doctor.first_name?.[0]}{doctor.last_name?.[0]}
                                    </div>
                                    <h4 className="font-semibold text-slate-800 text-lg">Dr. {doctor.first_name} {doctor.last_name}</h4>
                                    <p className="text-sm font-medium text-indigo-600 mt-1 mb-3 bg-indigo-50 px-3 py-1 rounded-full">
                                        {doctor.speciality || 'General Practitioner'}
                                    </p>
                                    
                                    <div className="w-full mt-auto pt-4 space-y-2 text-left border-t border-slate-100">
                                        {doctor.phone && (
                                            <div className="flex items-center text-sm text-slate-600 gap-3">
                                                <div className="bg-slate-50 p-1.5 rounded-md text-slate-400">
                                                    <Phone className="h-3.5 w-3.5" />
                                                </div>
                                                <span>{doctor.phone}</span>
                                            </div>
                                        )}
                                        {doctor.years_of_exp !== undefined && doctor.years_of_exp !== null && (
                                            <div className="flex items-center text-sm text-slate-600 gap-3">
                                                <div className="bg-slate-50 p-1.5 rounded-md text-slate-400">
                                                    <Settings className="h-3.5 w-3.5" />
                                                </div>
                                                <span>{doctor.years_of_exp} Years Experience</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="bg-slate-50 p-3 flex justify-center border-t border-slate-200 text-sm font-medium text-slate-600 group-hover:bg-indigo-50 group-hover:text-indigo-600 transition-colors">
                                    View Details & Docs
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Modals */}
                <AddDoctorModal
                    isOpen={isAddModalOpen}
                    onClose={() => setIsAddModalOpen(false)}
                    onSubmit={handleAddSubmit}
                    isSubmitting={isSubmitting}
                />

                <DoctorDetailsModal
                    isOpen={!!selectedDoctorForDetails}
                    doctor={selectedDoctorForDetails}
                    onClose={() => setSelectedDoctorForDetails(null)}
                    onRefresh={onRefresh}
                />
            </CardContent>
        </Card>
    );
};
