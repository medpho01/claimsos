import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, Loader, X, LayoutGrid, Settings as SettingsIcon } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import ApiService from '@/services/api';
import FilePreviewModal from '@/components/FilePreviewModal';
import { usePanelFleet } from '@/hooks/usePanelFleet';
import { usePanelAttributes } from '@/hooks/usePanelAttributes';
import { PanelOverviewTab } from './panels/PanelOverviewTab';
import { PanelConfigureTab } from './panels/PanelConfigureTab';
import type {
  AttributeDefinition,
  Panel,
  PreviewFile,
} from './panels/types';

interface PanelsManagerProps {
  hospitalId: string;
}

/**
 * PanelsManager — thin orchestrator for the Panels tab (FE M14 split).
 *
 * Previously a 1721-line god component (FE-review M14). Split into:
 *   - usePanelFleet hook + usePanelAttributes hook
 *   - PanelOverviewTab (fleet table + Link Panel CTA)
 *   - PanelConfigureTab (panel picker + attribute editor)
 *   - PanelAttribute{Add,Edit,Delete}Dialog (each owns its own form state — FE H13)
 *
 * Stays here:
 *   - top-level tab state (Overview ↔ Configure)
 *   - load of `panels` list + attribute `definitions` (shared between tabs)
 *   - global error banner
 *   - file preview modal mount
 *   - selectedPanel reconciliation after fleet refresh (fixes FE H11)
 */
export default function PanelsManager({ hospitalId }: PanelsManagerProps) {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<Panel | null>(null);
  const [subTab, setSubTab] = useState<'overview' | 'configure'>('overview');
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const editorRef = useRef<HTMLDivElement | null>(null);

  const { fleet, loading: fleetLoading, refresh: refreshFleet } = usePanelFleet(hospitalId);
  const {
    attributes: panelAttributes,
    error: attributesError,
    refresh: refreshAttributes,
  } = usePanelAttributes(hospitalId, selectedPanel);

  // Surface attribute-hook errors through the global banner.
  useEffect(() => {
    if (attributesError) setError(attributesError);
  }, [attributesError]);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [panelsRes, defsRes] = await Promise.all([
        ApiService.getHospitalPanels(hospitalId),
        ApiService.getPanelAttributeDefinitionsByCategory(),
      ]);

      const panelsList: Panel[] = panelsRes.data.data || [];
      setPanels(panelsList);

      // Flatten definitions from category structure
      const allDefs: AttributeDefinition[] = [];
      const defsData = defsRes.data.data || [];
      if (Array.isArray(defsData)) {
        defsData.forEach((categoryGroup: any) => {
          if (categoryGroup.definitions && Array.isArray(categoryGroup.definitions)) {
            const defsWithCategory = categoryGroup.definitions.map((def: any) => ({
              ...def,
              category: categoryGroup.category || def.category,
            }));
            allDefs.push(...defsWithCategory);
          }
        });
      }
      setDefinitions(allDefs);

      // Reconcile selectedPanel after a refresh.
      // FE H11 fix: if the previously-selected panel was deleted (or otherwise
      // missing from the new list), fall back to the same id if still present,
      // else the first panel, else null.
      setSelectedPanel((prev) => {
        if (!prev) {
          return panelsList.length > 0 ? panelsList[0] : null;
        }
        return panelsList.find((p) => p.id === prev.id) ?? panelsList[0] ?? null;
      });
    } catch (err: any) {
      console.error('Error fetching data:', err);
      setError(err?.response?.data?.message || 'Failed to load panels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hospitalId]);

  /**
   * Called after an attribute mutation. Refreshes fleet (attribute counts in
   * the table) + the per-panel attribute list. Panels list itself does not
   * change on attribute CRUD, so we don't re-run fetchData here.
   */
  const refreshAll = async () => {
    await Promise.all([refreshFleet(), refreshAttributes()]);
  };

  /**
   * Called after a panel-list-changing operation (link/unlink panel). Also
   * refetches `panels` so the H11 reconciliation in fetchData reruns and
   * `selectedPanel` is reset if it was deleted.
   */
  const refreshAllIncludingPanels = async () => {
    await Promise.all([refreshFleet(), fetchData()]);
  };

  const handleConfigure = (panelId: string) => {
    const panel = panels.find(
      (p) => p.id === panelId || (p as any).panel_id === panelId,
    );
    if (panel) {
      setSelectedPanel(panel);
      setSubTab('configure');
      setTimeout(() => {
        editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }
  };

  const handlePreviewDocument = (file: PreviewFile) => {
    setPreviewFile(file);
    setShowPreviewModal(true);
  };

  if (loading && !selectedPanel && panels.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center justify-center">
          <Loader className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-5 w-5" />
                {error}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setError(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as 'overview' | 'configure')}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="overview" className="gap-2">
            <LayoutGrid className="h-4 w-4" />
            Overview
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 h-5 text-[10px]">
              {fleet.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="configure" className="gap-2">
            <SettingsIcon className="h-4 w-4" />
            Configure
            {selectedPanel && subTab === 'configure' && (
              <span className="ml-1 text-xs text-muted-foreground truncate max-w-[120px]">
                · {(selectedPanel as any).panel_name || selectedPanel.panelName}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <PanelOverviewTab
            hospitalId={hospitalId}
            fleet={fleet}
            loading={fleetLoading}
            onConfigure={handleConfigure}
            onRefresh={refreshAllIncludingPanels}
          />
        </TabsContent>

        <TabsContent value="configure" className="mt-4">
          <PanelConfigureTab
            ref={editorRef}
            hospitalId={hospitalId}
            panels={panels}
            selectedPanel={selectedPanel}
            onSelectPanel={setSelectedPanel}
            attributes={panelAttributes}
            definitions={definitions}
            onSaved={refreshAll}
            onError={setError}
            onPreviewDocument={handlePreviewDocument}
          />
        </TabsContent>
      </Tabs>

      {previewFile && (
        <FilePreviewModal
          open={showPreviewModal}
          onOpenChange={(open) => {
            setShowPreviewModal(open);
            if (!open) setPreviewFile(null);
          }}
          fileName={previewFile.fileName}
          mimeType={previewFile.mimeType}
          documentId={previewFile.documentId}
          hospitalId={hospitalId}
        />
      )}
    </div>
  );
}
