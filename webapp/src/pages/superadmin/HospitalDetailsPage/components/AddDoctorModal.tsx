import React, { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

const doctorSchema = z.object({
    firstName: z.string().min(2, "First Name must be at least 2 characters"),
    lastName: z.string().optional(),
    age: z.string().optional().transform(v => v ? parseInt(v) : undefined),
    speciality: z.string().optional(),
    phone: z.string().refine(val => !val || val.length === 10, { message: "Phone must be 10 digits" }).optional(),
    yearsOfExp: z.string().optional().transform(v => v ? parseInt(v) : undefined),
});

type DoctorFormValues = z.infer<typeof doctorSchema>;

interface AddDoctorModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (data: any) => Promise<void>;
    isSubmitting: boolean;
    initialData?: any; // If provided, modal acts as 'Edit'
}

const AddDoctorModal: React.FC<AddDoctorModalProps> = ({
    isOpen,
    onClose,
    onSubmit,
    isSubmitting,
    initialData
}) => {
    const {
        register,
        handleSubmit,
        reset,
        formState: { errors }
    } = useForm<DoctorFormValues>({
        resolver: zodResolver(doctorSchema),
        defaultValues: {
            firstName: "",
            lastName: "",
            age: undefined,
            speciality: "",
            phone: "",
            yearsOfExp: undefined
        }
    });

    useEffect(() => {
        if (isOpen) {
            if (initialData) {
                reset({
                    firstName: initialData.first_name || "",
                    lastName: initialData.last_name || "",
                    age: initialData.age ? initialData.age.toString() : undefined,
                    speciality: initialData.speciality || "",
                    phone: initialData.phone || "",
                    yearsOfExp: initialData.years_of_exp ? initialData.years_of_exp.toString() : undefined,
                });
            } else {
                reset({
                    firstName: "",
                    lastName: "",
                    age: undefined,
                    speciality: "",
                    phone: "",
                    yearsOfExp: undefined
                });
            }
        }
    }, [isOpen, initialData, reset]);

    const handleFormSubmit = async (data: DoctorFormValues) => {
        await onSubmit(data);
        if (!isSubmitting) onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>{initialData ? "Edit Doctor" : "Add New Doctor"}</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="firstName">First Name <span className="text-red-500">*</span></Label>
                            <Input
                                id="firstName"
                                placeholder="John"
                                {...register("firstName")}
                                className={errors.firstName ? 'border-red-500' : ''}
                            />
                            {errors.firstName && <p className="text-red-500 text-xs">{errors.firstName.message}</p>}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="lastName">Last Name</Label>
                            <Input
                                id="lastName"
                                placeholder="Doe"
                                {...register("lastName")}
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="age">Age</Label>
                            <Input
                                id="age"
                                type="number"
                                placeholder="e.g. 45"
                                {...register("age")}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="phone">Phone Number</Label>
                            <Input
                                id="phone"
                                type="tel"
                                maxLength={10}
                                placeholder="10-digit number"
                                {...register("phone", {
                                    onChange: (e) => {
                                        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
                                    }
                                })}
                                className={errors.phone ? 'border-red-500' : ''}
                            />
                            {errors.phone && <p className="text-red-500 text-xs">{errors.phone.message}</p>}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="speciality">Speciality</Label>
                            <Input
                                id="speciality"
                                placeholder="e.g. Cardiologist"
                                {...register("speciality")}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="yearsOfExp">Years of Experience</Label>
                            <Input
                                id="yearsOfExp"
                                type="number"
                                placeholder="e.g. 15"
                                {...register("yearsOfExp")}
                            />
                        </div>
                    </div>

                    <DialogFooter className="pt-4">
                        <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isSubmitting}>
                            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {initialData ? "Save Changes" : "Save Doctor"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default AddDoctorModal;
