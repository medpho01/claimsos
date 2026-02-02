import React from "react";
import { UseFormReturn } from "react-hook-form";
import { Label } from "../../../ui/label";
import { Input } from "../../../ui/input";
import { ClaimsFormData } from "../types";

interface ClaimsFieldsProps {
    form: UseFormReturn<ClaimsFormData>;
}

export const ClaimsFields: React.FC<ClaimsFieldsProps> = ({ form }) => {
    return (
        <>
            <div className="grid gap-2 col-span-1 md:col-span-2">
                <Label>Treatment Plan</Label>
                <textarea
                    {...form.register("treatmentPlan")}
                    placeholder="e.g., Plate(SB071B-Implant Removal under RA / GA)"
                    rows={2}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
            </div>
            <div className="grid gap-2 col-span-1 md:col-span-2">
                <Label>Latest Status</Label>
                <Input
                    type="text"
                    {...form.register("latestStatus")}
                    placeholder="e.g., Claim paid on 26/08/2025"
                />
            </div>
            <div className="grid gap-2">
                <Label>Claim Amount (₹)</Label>
                <Input
                    type="number"
                    {...form.register("claimAmount")}
                    placeholder="e.g., 122860"
                    step="0.01"
                    min="0"
                    className={form.formState.errors.claimAmount ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {form.formState.errors.claimAmount && (
                    <p className="text-sm text-red-500">{form.formState.errors.claimAmount.message}</p>
                )}
            </div>
            <div className="grid gap-2">
                <Label>Claim Approved (₹)</Label>
                <Input
                    type="number"
                    {...form.register("claimApproved")}
                    placeholder="e.g., 100000"
                    step="0.01"
                    min="0"
                    className={form.formState.errors.claimApproved ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {form.formState.errors.claimApproved && (
                    <p className="text-sm text-red-500">{form.formState.errors.claimApproved.message}</p>
                )}
            </div>
            <div className="grid gap-2">
                <Label>Incentive (₹)</Label>
                <Input
                    type="number"
                    {...form.register("incentive")}
                    placeholder="e.g., 5000"
                    step="0.01"
                    min="0"
                    className={form.formState.errors.incentive ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {form.formState.errors.incentive && (
                    <p className="text-sm text-red-500">{form.formState.errors.incentive.message}</p>
                )}
            </div>
            <div className="grid gap-2">
                <Label>Deduction (₹)</Label>
                <Input
                    type="number"
                    {...form.register("deduction")}
                    placeholder="e.g., 2000"
                    step="0.01"
                    min="0"
                    className={form.formState.errors.deduction ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {form.formState.errors.deduction && (
                    <p className="text-sm text-red-500">{form.formState.errors.deduction.message}</p>
                )}
            </div>
            <div className="grid gap-2 col-span-1 md:col-span-2">
                <Label>Deduction Reason</Label>
                <Input
                    type="text"
                    {...form.register("deductionReason")}
                    placeholder="e.g., Documentation incomplete"
                />
            </div>
            <div className="grid gap-2">
                <Label>Claim Settled (₹)</Label>
                <Input
                    type="number"
                    {...form.register("claimSettled")}
                    placeholder="e.g., 98000"
                    step="0.01"
                    min="0"
                    className={form.formState.errors.claimSettled ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {form.formState.errors.claimSettled && (
                    <p className="text-sm text-red-500">{form.formState.errors.claimSettled.message}</p>
                )}
            </div>
            <div className="grid gap-2">
                <Label>Settlement Date</Label>
                <Input
                    type="date"
                    {...form.register("claimSettledDate")}
                />
            </div>
        </>
    );
};
