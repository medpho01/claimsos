import React, { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link as LinkIcon } from 'lucide-react';
import PanelsFleetTable, { FleetPanel } from '../PanelsFleetTable';
import LinkPanelModal from '@/components/modals/LinkPanelModal';

interface PanelOverviewTabProps {
  hospitalId: string;
  fleet: FleetPanel[];
  loading: boolean;
  onConfigure: (panelId: string) => void;
  onRefresh: () => void;
}

/**
 * Overview sub-tab of PanelsManager — fleet table + Link Panel CTA.
 * Extracted from PanelsManager.tsx during the M14 split.
 */
export function PanelOverviewTab({
  hospitalId,
  fleet,
  loading,
  onConfigure,
  onRefresh,
}: PanelOverviewTabProps) {
  const [showLinkPanelModal, setShowLinkPanelModal] = useState(false);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Panel Fleet</CardTitle>
            <CardDescription>
              All panels linked to this hospital with their portal access details.
              Click a row to see every configured attribute; click{' '}
              <span className="font-medium">Configure</span> to jump to the editor.
            </CardDescription>
          </div>
          <Button
            onClick={() => setShowLinkPanelModal(true)}
            className="bg-brand-600 hover:bg-brand-700 text-white gap-2 shrink-0"
          >
            <LinkIcon className="h-4 w-4" />
            Link Panel
          </Button>
        </CardHeader>
        <CardContent>
          <PanelsFleetTable
            fleet={fleet}
            loading={loading}
            onConfigure={onConfigure}
            onRefresh={onRefresh}
          />
        </CardContent>
      </Card>

      {showLinkPanelModal && hospitalId && (
        <LinkPanelModal
          hospitalId={hospitalId}
          onClose={() => setShowLinkPanelModal(false)}
          onSuccess={() => {
            setShowLinkPanelModal(false);
            onRefresh();
          }}
        />
      )}
    </>
  );
}
