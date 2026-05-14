import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Edit2, Trash2 } from 'lucide-react';
import { DoctorAttribute, AttributeDefinition } from '../types';

interface CredentialsGroupedListProps {
  credentials: DoctorAttribute[];
  definitions: Record<string, AttributeDefinition>;
  onEdit: (credential: DoctorAttribute) => void;
  onDelete: (credential: DoctorAttribute) => void;
  isLoading?: boolean;
}

const getVerificationBadgeColor = (status?: string) => {
  switch (status) {
    case 'verified_by_doc':
      return 'bg-green-100 text-green-800';
    case 'verified_by_image':
      return 'bg-brand-50 text-brand-700';
    case 'verified_by_online':
      return 'bg-cyan-100 text-cyan-800';
    case 'pending_review':
      return 'bg-yellow-100 text-yellow-800';
    case 'rejected':
      return 'bg-red-100 text-red-800';
    case 'expired':
      return 'bg-orange-100 text-orange-800';
    default:
      return 'bg-slate-100 text-slate-800';
  }
};

const groupCredentialsByCategory = (
  credentials: DoctorAttribute[]
): Record<string, DoctorAttribute[]> => {
  return credentials.reduce(
    (acc, credential) => {
      const category = credential.category || 'Other';
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(credential);
      return acc;
    },
    {} as Record<string, DoctorAttribute[]>
  );
};

const isCredentialExpiring = (expiresAt?: string): boolean => {
  if (!expiresAt) return false;
  const expiryDate = new Date(expiresAt);
  const today = new Date();
  const thirtyDaysFromNow = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
  return expiryDate <= thirtyDaysFromNow && expiryDate > today;
};

const isCredentialExpired = (expiresAt?: string): boolean => {
  if (!expiresAt) return false;
  const expiryDate = new Date(expiresAt);
  const today = new Date();
  return expiryDate <= today;
};

export const CredentialsGroupedList: React.FC<CredentialsGroupedListProps> = ({
  credentials,
  definitions,
  onEdit,
  onDelete,
  isLoading = false,
}) => {
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});

  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <p className="text-slate-500">Loading credentials...</p>
        </div>
      </Card>
    );
  }

  if (credentials.length === 0) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center py-8">
          <p className="text-slate-500">No credentials added yet</p>
        </div>
      </Card>
    );
  }

  const groupedCredentials = groupCredentialsByCategory(credentials);
  const categories = Object.keys(groupedCredentials).sort();

  return (
    <div className="space-y-4">
      {categories.map((category) => (
        <div key={category} className="border border-slate-200 rounded-lg overflow-hidden">
          {/* Category Header */}
          <button
            onClick={() =>
              setExpandedCategories((prev) => ({
                ...prev,
                [category]: !prev[category],
              }))
            }
            className="w-full bg-slate-100 px-4 py-3 hover:bg-slate-200 transition-colors flex items-center justify-between"
          >
            <h4 className="text-sm font-semibold text-slate-900 capitalize">
              {category} ({groupedCredentials[category].length})
            </h4>
            <span className="text-slate-600">
              {expandedCategories[category] ? '▼' : '▶'}
            </span>
          </button>

          {/* Credentials in Category */}
          {expandedCategories[category] && (
            <div className="divide-y divide-slate-200">
              {groupedCredentials[category].map((credential) => {
                const definition = definitions[credential.attribute_key];
                const expired = isCredentialExpired(credential.expires_at);
                const expiring = !expired && isCredentialExpiring(credential.expires_at);

                return (
                  <div key={credential.id} className="p-4 hover:bg-slate-50 transition-colors">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-900">
                          {credential.label || definition?.label || credential.attribute_key}
                        </p>

                        {/* Value Display */}
                        <div className="mt-2 space-y-1">
                          {credential.value_text && (
                            <p className="text-sm text-slate-600">
                              <span className="font-medium">Value:</span> {credential.value_text}
                            </p>
                          )}
                          {credential.value_date && (
                            <p className="text-sm text-slate-600">
                              <span className="font-medium">Date:</span>{' '}
                              {new Date(credential.value_date).toLocaleDateString()}
                            </p>
                          )}
                          {credential.value_boolean !== undefined && (
                            <p className="text-sm text-slate-600">
                              <span className="font-medium">Status:</span>{' '}
                              {credential.value_boolean ? 'Yes' : 'No'}
                            </p>
                          )}

                          {/* Certificate Details */}
                          {credential.certificate_number && (
                            <p className="text-xs text-slate-500">
                              Cert #: {credential.certificate_number}
                            </p>
                          )}
                          {credential.issuing_authority && (
                            <p className="text-xs text-slate-500">
                              Issued by: {credential.issuing_authority}
                            </p>
                          )}
                          {credential.issued_at && (
                            <p className="text-xs text-slate-500">
                              Issued: {new Date(credential.issued_at).toLocaleDateString()}
                            </p>
                          )}

                          {/* Expiry Information */}
                          {credential.expires_at && (
                            <div className={`text-xs mt-2 p-2 rounded ${
                              expired
                                ? 'bg-red-50 text-red-700'
                                : expiring
                                ? 'bg-yellow-50 text-yellow-700'
                                : 'bg-green-50 text-green-700'
                            }`}>
                              {expired ? (
                                <div className="flex items-center gap-1">
                                  <AlertCircle className="h-3 w-3" />
                                  Expired: {new Date(credential.expires_at).toLocaleDateString()}
                                </div>
                              ) : expiring ? (
                                <div className="flex items-center gap-1">
                                  <AlertCircle className="h-3 w-3" />
                                  Expiring soon: {new Date(credential.expires_at).toLocaleDateString()}
                                </div>
                              ) : (
                                <div>Expires: {new Date(credential.expires_at).toLocaleDateString()}</div>
                              )}
                            </div>
                          )}

                          {/* Documents */}
                          {credential.documents && credential.documents.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-slate-200">
                              <p className="text-xs font-medium text-slate-600 mb-1">
                                Documents ({credential.documents.length}):
                              </p>
                              <div className="space-y-1">
                                {credential.documents.map((doc) => (
                                  <div
                                    key={doc.id}
                                    className="text-xs text-brand-600 hover:text-brand-700"
                                  >
                                    📄 {doc.file_name || `Document ${doc.id.slice(0, 8)}`}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Status Badge and Actions */}
                      <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                        <Badge className={getVerificationBadgeColor(credential.verification_status)}>
                          {credential.verification_status?.replace(/_/g, ' ') || 'Unverified'}
                        </Badge>

                        {/* Edit Button (only for non-document types) */}
                        {definition?.data_type !== 'document' && (
                          <button
                            onClick={() => onEdit(credential)}
                            className="p-1.5 text-brand-600 hover:bg-brand-50 rounded-md transition-colors"
                            title="Edit credential"
                          >
                            <Edit2 className="h-4 w-4" />
                          </button>
                        )}

                        {/* Delete Button */}
                        <button
                          onClick={() => onDelete(credential)}
                          className="p-1.5 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          title="Delete credential"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
