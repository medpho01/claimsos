import React, { forwardRef } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { PanelAttributeEditor } from './PanelAttributeEditor';
import type {
  AttributeDefinition,
  Panel,
  PanelAttribute,
  PreviewFile,
} from './types';

interface PanelConfigureTabProps {
  hospitalId: string;
  panels: Panel[];
  selectedPanel: Panel | null;
  onSelectPanel: (panel: Panel | null) => void;
  attributes: PanelAttribute[];
  definitions: AttributeDefinition[];
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
  onPreviewDocument: (file: PreviewFile) => void;
}

/**
 * Configure sub-tab of PanelsManager — panel picker + attribute editor.
 * Forwards a ref to the outer Card so the parent can scrollIntoView when the
 * user clicks "Configure" on a fleet row.
 *
 * Extracted from PanelsManager.tsx during the M14 split.
 */
export const PanelConfigureTab = forwardRef<HTMLDivElement, PanelConfigureTabProps>(
  function PanelConfigureTab(
    {
      hospitalId,
      panels,
      selectedPanel,
      onSelectPanel,
      attributes,
      definitions,
      onSaved,
      onError,
      onPreviewDocument,
    },
    ref,
  ) {
    return (
      <Card ref={ref}>
        <CardHeader>
          <CardTitle>Configure Panel</CardTitle>
          <CardDescription>
            {selectedPanel
              ? 'Add, edit, or remove attributes for the selected panel.'
              : 'Pick a panel below to start editing its attributes, or go back to Overview and click Configure on any row.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="panel-select">Select Panel</Label>
            {panels.length === 0 ? (
              <div className="p-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500">
                No panels available. Please link panels in Hospital Management first.
              </div>
            ) : (
              <select
                id="panel-select"
                value={selectedPanel?.id || ''}
                onChange={(e) => {
                  const panel = panels.find((p) => p.id === e.target.value);
                  onSelectPanel(panel || null);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-600"
              >
                <option value="">-- Select a panel --</option>
                {panels.map((panel) => (
                  <option key={panel.id} value={panel.id}>
                    {(panel as any).panel_name ||
                      panel.panelName ||
                      'Unnamed Panel'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedPanel && (
            <PanelAttributeEditor
              hospitalId={hospitalId}
              panel={selectedPanel}
              attributes={attributes}
              definitions={definitions}
              onSaved={onSaved}
              onError={onError}
              onPreviewDocument={onPreviewDocument}
            />
          )}
        </CardContent>
      </Card>
    );
  },
);
