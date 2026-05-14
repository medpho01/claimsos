import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { AlertCircle, Plus, Loader } from 'lucide-react';
import { toast } from 'sonner';
import ApiService from '@/services/api';
import {
  DoctorAttribute,
  AttributeDefinition,
  AttributeDefinitionsGrouped,
  CredentialFormData,
  TabStatus,
} from '../types';
import { CredentialsGroupedList } from './CredentialsGroupedList';
import { AddCredentialDialog } from './AddCredentialDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface CredentialsTabProps {
  doctorId: string;
  tabStatus: TabStatus;
  setTabStatus: (status: TabStatus | ((prev: TabStatus) => TabStatus)) => void;
}

export const CredentialsTab: React.FC<CredentialsTabProps> = ({
  doctorId,
  tabStatus,
  setTabStatus,
}) => {
  const [credentials, setCredentials] = useState<DoctorAttribute[]>([]);
  const [definitions, setDefinitions] = useState<Record<string, AttributeDefinition>>({});
  const [attributeDefinitionsGrouped, setAttributeDefinitionsGrouped] =
    useState<AttributeDefinitionsGrouped>({});
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedCredential, setSelectedCredential] = useState<DoctorAttribute | null>(null);
  const [credentialToDelete, setCredentialToDelete] = useState<DoctorAttribute | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load credentials and definitions on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoadingData(true);
        setTabStatus({ ...tabStatus, error: null });

        // Load definitions and credentials in parallel
        const [defsResponse, credentialsResponse] = await Promise.all([
          ApiService.getDoctorAttributeDefinitionsGrouped(),
          ApiService.getDoctorAttributes(doctorId),
        ]);

        // Process definitions
        const grouped = defsResponse.data?.data || {};
        setAttributeDefinitionsGrouped(grouped);

        // Flatten definitions for easy lookup by key
        const flat: Record<string, AttributeDefinition> = {};
        Object.entries(grouped).forEach(([category, defs]) => {
          (defs as AttributeDefinition[]).forEach((def: AttributeDefinition) => {
            flat[def.key] = { ...def, category };
          });
        });
        setDefinitions(flat);

        // Process credentials
        const creds = credentialsResponse.data?.data || [];
        setCredentials(Array.isArray(creds) ? creds : []);
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to load credentials';
        setTabStatus({ ...tabStatus, error: errorMsg });
        console.error('Error loading credentials:', err);
      } finally {
        setIsLoadingData(false);
      }
    };

    loadData();
  }, [doctorId]);

  const handleAddCredential = async (
    data: CredentialFormData,
    files?: File[]
  ) => {
    try {
      setIsSubmitting(true);
      setTabStatus({ ...tabStatus, error: null });

      // Prepare API payload
      const apiPayload: any = {
        documentIds: [],
      };

      // Set value based on data type
      const definition = definitions[data.attributeKey];
      if (definition) {
        if (definition.data_type === 'text' || definition.data_type === 'textarea') {
          apiPayload.valueText = data.valueText;
        } else if (definition.data_type === 'date') {
          apiPayload.valueDate = data.valueDate;
        } else if (definition.data_type === 'boolean') {
          apiPayload.valueBoolean = data.valueBoolean;
        } else if (definition.data_type === 'document') {
          apiPayload.valueText = definition.label || 'Document';
        }
      }

      // Add optional fields
      if (data.certificateNumber) apiPayload.certificateNumber = data.certificateNumber;
      if (data.issuingAuthority) apiPayload.issuingAuthority = data.issuingAuthority;
      if (data.issuedAt) apiPayload.issuedAt = data.issuedAt;
      if (data.expiresAt) apiPayload.expiresAt = data.expiresAt;

      // Create or update credential
      const response = await ApiService.setDoctorAttribute(
        doctorId,
        data.attributeKey,
        apiPayload
      );

      // Handle file uploads if any
      if (files && files.length > 0 && response.data?.data?.id) {
        const attributeId = response.data.data.id;
        for (const file of files) {
          try {
            await ApiService.addAttributeDocument(doctorId, attributeId, file);
          } catch (fileErr) {
            console.error('Error uploading file:', fileErr);
            toast.error(`Failed to upload ${file.name}`);
          }
        }
      }

      // Refresh credentials list
      const credentialsResponse = await ApiService.getDoctorAttributes(doctorId);
      const creds = credentialsResponse.data?.data || [];
      setCredentials(Array.isArray(creds) ? creds : []);

      toast.success(
        selectedCredential
          ? 'Credential updated successfully'
          : 'Credential added successfully'
      );

      // Reset form
      setSelectedCredential(null);
      setIsAddDialogOpen(false);

      // Show success state
      setTabStatus({ ...tabStatus, success: true, isDirty: false });
      setTimeout(
        () =>
          setTabStatus((prev) => ({
            ...prev,
            success: false,
          })),
        3000
      );
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to save credential';
      setTabStatus({ ...tabStatus, error: errorMsg });
      toast.error(errorMsg);
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditCredential = (credential: DoctorAttribute) => {
    setSelectedCredential(credential);
    setIsAddDialogOpen(true);
  };

  const handleDeleteCredential = async (credential: DoctorAttribute) => {
    try {
      setTabStatus({ ...tabStatus, error: null });
      await ApiService.deleteDoctorAttribute(doctorId, credential.id);

      // Refresh list
      const response = await ApiService.getDoctorAttributes(doctorId);
      const creds = response.data?.data || [];
      setCredentials(Array.isArray(creds) ? creds : []);

      toast.success('Credential deleted successfully');
      setCredentialToDelete(null);

      // Show success state
      setTabStatus({ ...tabStatus, success: true, isDirty: false });
      setTimeout(
        () =>
          setTabStatus((prev) => ({
            ...prev,
            success: false,
          })),
        3000
      );
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to delete credential';
      setTabStatus({ ...tabStatus, error: errorMsg });
      toast.error(errorMsg);
    }
  };

  return (
    <div className="space-y-4">
      {/* Success Alert */}
      {tabStatus.success && (
        <Alert className="bg-green-50 border-green-200">
          <AlertDescription className="text-green-800">
            ✓ Credentials updated successfully!
          </AlertDescription>
        </Alert>
      )}

      {/* Error Alert */}
      {tabStatus.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{tabStatus.error}</AlertDescription>
        </Alert>
      )}

      {/* Add Credential Button */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold text-slate-900">
          Credentials & Qualifications
        </h3>
        <Button
          onClick={() => {
            setSelectedCredential(null);
            setIsAddDialogOpen(true);
          }}
          className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
          disabled={isLoadingData}
        >
          <Plus className="h-4 w-4" />
          Add Credential
        </Button>
      </div>

      {/* Credentials List */}
      {isLoadingData ? (
        <Card className="p-6">
          <div className="flex items-center justify-center py-8">
            <Loader className="h-5 w-5 animate-spin text-slate-400 mr-2" />
            <p className="text-slate-500">Loading credentials...</p>
          </div>
        </Card>
      ) : (
        <CredentialsGroupedList
          credentials={credentials}
          definitions={definitions}
          onEdit={handleEditCredential}
          onDelete={(cred) => setCredentialToDelete(cred)}
          isLoading={false}
        />
      )}

      {/* Add/Edit Credential Dialog */}
      <AddCredentialDialog
        open={isAddDialogOpen}
        onOpenChange={(open) => {
          setIsAddDialogOpen(open);
          if (!open) {
            setSelectedCredential(null);
          }
        }}
        attributeDefinitionsGrouped={attributeDefinitionsGrouped}
        credential={selectedCredential || undefined}
        onSubmit={handleAddCredential}
        isSubmitting={isSubmitting}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!credentialToDelete} onOpenChange={(open) => !open && setCredentialToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Credential?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this credential? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => credentialToDelete && handleDeleteCredential(credentialToDelete)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
