import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Plus, Trash2, Edit2 } from 'lucide-react';
import { PanelAttributeDocumentRow } from './PanelAttributeDocumentRow';
import { PanelAttributeAddDialog } from './PanelAttributeAddDialog';
import { PanelAttributeEditDialog } from './PanelAttributeEditDialog';
import { PanelAttributeDeleteDialog } from './PanelAttributeDeleteDialog';
import { renderAttributeValue } from './attributeApi';
import type {
  AttributeDefinition,
  Panel,
  PanelAttribute,
  PreviewFile,
} from './types';

interface PanelAttributeEditorProps {
  hospitalId: string;
  panel: Panel;
  attributes: PanelAttribute[];
  definitions: AttributeDefinition[];
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
  onPreviewDocument: (file: PreviewFile) => void;
}

/**
 * The "attribute list + Add/Edit/Delete dialogs" block of the Configure tab.
 *
 * Extracted from PanelsManager.tsx during the M14 split. Add/Edit dialogs
 * each own their own form state (fixes FE H13).
 */
export function PanelAttributeEditor({
  hospitalId,
  panel,
  attributes,
  definitions,
  onSaved,
  onError,
  onPreviewDocument,
}: PanelAttributeEditorProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<PanelAttribute | null>(null);
  const [deleteId, setDeleteId] = useState<string>('');

  const categories = useMemo(
    () => [
      'all',
      ...Array.from(
        new Set(
          definitions
            .map((d) => d.category)
            .filter((cat): cat is string => Boolean(cat)),
        ),
      ),
    ],
    [definitions],
  );

  const filteredAttributes = useMemo(() => {
    if (selectedCategory === 'all') return attributes;
    return attributes.filter((attr) => {
      const attrKey = attr.attributeKey || (attr as any).attribute_key;
      const def = definitions.find((d) => d.key === attrKey);
      return def?.category === selectedCategory;
    });
  }, [attributes, definitions, selectedCategory]);

  return (
    <>
      <div className="flex items-center justify-between pt-4 border-t">
        <div>
          <h3 className="font-semibold">Attributes</h3>
          <p className="text-sm text-gray-600">
            {filteredAttributes.length} configured{' '}
            {selectedCategory !== 'all' ? `in ${selectedCategory}` : ''}
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Attribute
        </Button>
      </div>

      {categories.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {categories.map((cat) => {
            const isActive = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={
                  `px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ` +
                  (isActive
                    ? 'bg-brand-600 text-white border-brand-600 hover:bg-brand-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 hover:border-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-800')
                }
              >
                {cat && cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            );
          })}
        </div>
      )}

      {filteredAttributes.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No attributes found in this category
        </div>
      ) : (
        <div className="space-y-3">
          {filteredAttributes.map((attr) => {
            const attrKey = attr.attributeKey || (attr as any).attribute_key;
            const attrDef = definitions.find((d) => d.key === attrKey);
            return (
              <div key={attr.id} className="p-4 border rounded-lg space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold">
                        {attr.label || attrDef?.label || attrKey}
                      </h4>
                      {attr.documents && attr.documents.length > 0 && (
                        <span className="inline-block bg-brand-50 text-brand-700 text-xs font-medium px-2 py-0.5 rounded">
                          {attr.documents.length}{' '}
                          {attr.documents.length === 1 ? 'doc' : 'docs'}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600">{attrDef?.description}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-gray-600">Value: </span>
                    <span className="font-medium">{renderAttributeValue(attr)}</span>
                  </div>
                </div>

                {attr.documents && attr.documents.length > 0 && (
                  <div className="space-y-2 p-3 border rounded-md bg-gray-50 dark:bg-gray-900/20 mt-3">
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-sm font-semibold">
                        Documents ({attr.documents.length})
                      </Label>
                    </div>
                    <div className="space-y-2">
                      {attr.documents.map((doc) => (
                        <PanelAttributeDocumentRow
                          key={doc.id}
                          doc={doc}
                          hospitalId={hospitalId}
                          enableDownload
                          onPreview={(d) =>
                            onPreviewDocument({
                              fileName: d.fileName,
                              mimeType: d.mimeType,
                              documentId: d.documentId,
                            })
                          }
                          onError={onError}
                        />
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2 border-t">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(attr)}
                    className="gap-2"
                  >
                    <Edit2 className="h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDeleteId(attr.id)}
                    className="gap-2 text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PanelAttributeAddDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        hospitalId={hospitalId}
        panel={panel}
        definitions={definitions}
        existingAttributes={attributes}
        onSaved={onSaved}
        onError={onError}
      />

      <PanelAttributeEditDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        hospitalId={hospitalId}
        panel={panel}
        attribute={editing}
        definitions={definitions}
        onSaved={onSaved}
        onError={onError}
        onPreviewDocument={onPreviewDocument}
      />

      <PanelAttributeDeleteDialog
        open={deleteId !== ''}
        onOpenChange={(open) => !open && setDeleteId('')}
        hospitalId={hospitalId}
        panel={panel}
        attributeId={deleteId}
        onDeleted={onSaved}
        onError={onError}
      />
    </>
  );
}
