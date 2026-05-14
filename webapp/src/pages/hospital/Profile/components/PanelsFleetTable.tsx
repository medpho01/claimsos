import React, { useMemo, useState } from "react";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    ChevronDown,
    ChevronRight,
    ExternalLink,
    Eye,
    EyeOff,
    Copy,
    Check,
    Search,
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
    Wifi,
    WifiOff,
    HelpCircle,
    Pencil,
    Plus,
} from "lucide-react";

/**
 * Shape of one entry returned by GET /hospitals/:hospitalId/panels-fleet.
 * One row per linked panel, with the full attribute list nested.
 */
export interface FleetAttribute {
    id: string;
    attribute_key: string;
    label: string;
    category: string;
    data_type: string;
    options?: Record<string, string> | null;
    sort_order?: number;
    value_text?: string | null;
    value_boolean?: boolean | null;
    value_date?: string | null;
    value_json?: any;
    value_encrypted?: string | null;
    document_id?: string | null;
    updated_at?: string | null;
}

export interface FleetPanel {
    hospital_panel_id: string;
    panel_id: string;
    panel_name: string;
    contact?: string | null;
    sheet_id?: string | null;
    drive_folder_id?: string | null;
    attributes: FleetAttribute[];
}

interface PanelsFleetTableProps {
    fleet: FleetPanel[];
    loading: boolean;
    onConfigure: (panelId: string) => void; // opens existing PanelsManager editor for that panel
    onRefresh?: () => void;
}

type SortKey = "panel_name" | "url" | "auth";
type SortDir = "asc" | "desc";

// Keys we surface as primary columns in the table. Everything else is exposed
// inside the expanded row (full attribute grid).
const PRIMARY_KEYS = [
    "portal_url",
    "portal_email",
    "portal_username",
    "portal_password",
    "authentication_type",
] as const;

/**
 * Read an attribute's display value regardless of which value_* column holds it.
 * For `encrypted_text` data type we currently store the plaintext in
 * `value_encrypted` (column is misleadingly named — see TECH_DEBT P1-X).
 */
const readValue = (attr?: FleetAttribute | null): string => {
    if (!attr) return "";
    switch (attr.data_type) {
        case "encrypted_text":
            return attr.value_encrypted ?? "";
        case "boolean":
            return attr.value_boolean === true
                ? "Yes"
                : attr.value_boolean === false
                ? "No"
                : "";
        case "date":
            return attr.value_date ? new Date(attr.value_date).toLocaleDateString() : "";
        case "json":
        case "multi_select":
            return attr.value_json ? JSON.stringify(attr.value_json) : "";
        case "single_select": {
            const code = attr.value_text || "";
            if (code && attr.options && typeof attr.options === "object") {
                return (attr.options as Record<string, string>)[code] || code;
            }
            return code;
        }
        default:
            return attr.value_text ?? "";
    }
};

const findAttr = (panel: FleetPanel, key: string): FleetAttribute | undefined =>
    panel.attributes.find((a) => a.attribute_key === key);

/**
 * Compute a basic "completeness" score per panel for the Health column.
 * This is a placeholder until the RPA fleet wires real connectivity probes.
 */
const computeHealth = (panel: FleetPanel) => {
    const hasUrl = !!readValue(findAttr(panel, "portal_url"));
    const hasUsername = !!readValue(findAttr(panel, "portal_username"));
    const hasPassword = !!readValue(findAttr(panel, "portal_password"));
    if (hasUrl && hasUsername && hasPassword) return "ready" as const;
    if (hasUrl || hasUsername || hasPassword) return "partial" as const;
    return "missing" as const;
};

/** Copy-to-clipboard with a quick "Copied!" affordance on the button. */
const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label }) => {
    const [copied, setCopied] = useState(false);
    if (!value) return null;
    const onClick = async (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore
        }
    };
    return (
        <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClick}
            title={label ? `Copy ${label}` : "Copy"}
        >
            {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
                <Copy className="h-3.5 w-3.5" />
            )}
        </Button>
    );
};

/**
 * Renders a credential value. Type can be plain (visible by default) or
 * secret (masked with reveal + copy). Inline so cells stay compact.
 */
const CredentialValue: React.FC<{
    value: string;
    masked?: boolean;
    placeholder?: string;
    monospace?: boolean;
}> = ({ value, masked = false, placeholder = "—", monospace = false }) => {
    const [revealed, setRevealed] = useState(false);
    if (!value) {
        return <span className="text-xs text-slate-400">{placeholder}</span>;
    }
    const display = masked && !revealed ? "••••••••" : value;
    return (
        <div className="flex items-center gap-1 min-w-0">
            <span
                className={`truncate ${monospace ? "font-mono text-xs" : "text-sm"} text-slate-800`}
                title={value}
            >
                {display}
            </span>
            {masked && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 shrink-0"
                    onClick={(e) => {
                        e.stopPropagation();
                        setRevealed((r) => !r);
                    }}
                    title={revealed ? "Hide" : "Reveal"}
                >
                    {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
            )}
            <CopyButton value={value} label={masked ? "credential" : undefined} />
        </div>
    );
};

const SortIndicator: React.FC<{ active: boolean; dir: SortDir }> = ({ active, dir }) => {
    if (!active) return <ArrowUpDown className="ml-1 h-3.5 w-3.5 opacity-40" />;
    return dir === "asc" ? (
        <ArrowUp className="ml-1 h-3.5 w-3.5" />
    ) : (
        <ArrowDown className="ml-1 h-3.5 w-3.5" />
    );
};

const HealthPill: React.FC<{ status: ReturnType<typeof computeHealth> }> = ({ status }) => {
    switch (status) {
        case "ready":
            return (
                <Badge variant="outline" className="gap-1 border-green-200 bg-green-50 text-green-700">
                    <Wifi className="h-3 w-3" />
                    Ready
                </Badge>
            );
        case "partial":
            return (
                <Badge variant="outline" className="gap-1 border-amber-200 bg-amber-50 text-amber-700">
                    <HelpCircle className="h-3 w-3" />
                    Partial
                </Badge>
            );
        default:
            return (
                <Badge variant="outline" className="gap-1 border-slate-200 bg-slate-50 text-slate-500">
                    <WifiOff className="h-3 w-3" />
                    Not set up
                </Badge>
            );
    }
};

const PanelsFleetTable: React.FC<PanelsFleetTableProps> = ({
    fleet,
    loading,
    onConfigure,
    onRefresh,
}) => {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("panel_name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");

    const toggleExpand = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const toggleSort = (k: SortKey) => {
        if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        else {
            setSortKey(k);
            setSortDir("asc");
        }
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return fleet;
        return fleet.filter((p) => {
            const blob = [
                p.panel_name,
                readValue(findAttr(p, "portal_url")),
                readValue(findAttr(p, "portal_email")),
                readValue(findAttr(p, "portal_username")),
                readValue(findAttr(p, "portal_name")),
            ]
                .join(" ")
                .toLowerCase();
            return blob.includes(q);
        });
    }, [fleet, search]);

    const sorted = useMemo(() => {
        const arr = [...filtered];
        const dir = sortDir === "asc" ? 1 : -1;
        arr.sort((a, b) => {
            switch (sortKey) {
                case "url":
                    return (
                        readValue(findAttr(a, "portal_url")).localeCompare(
                            readValue(findAttr(b, "portal_url"))
                        ) * dir
                    );
                case "auth":
                    return (
                        readValue(findAttr(a, "authentication_type")).localeCompare(
                            readValue(findAttr(b, "authentication_type"))
                        ) * dir
                    );
                case "panel_name":
                default:
                    return a.panel_name.localeCompare(b.panel_name) * dir;
            }
        });
        return arr;
    }, [filtered, sortKey, sortDir]);

    const renderHeader = (label: string, key: SortKey, align: "left" | "right" = "left") => (
        <button
            type="button"
            onClick={() => toggleSort(key)}
            className={`inline-flex items-center hover:text-foreground transition-colors ${
                align === "right" ? "ml-auto" : ""
            }`}
        >
            {label}
            <SortIndicator active={sortKey === key} dir={sortDir} />
        </button>
    );

    return (
        <div className="space-y-3">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-3">
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search panels by name, URL, email, username..."
                        className="pl-8 h-9"
                    />
                </div>
                {onRefresh && (
                    <Button variant="outline" size="sm" onClick={onRefresh}>
                        Refresh
                    </Button>
                )}
            </div>

            <div className="rounded-lg border bg-white overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-slate-50/80">
                            <TableHead className="w-8" />
                            <TableHead className="w-[18%]">{renderHeader("Panel", "panel_name")}</TableHead>
                            <TableHead className="w-[16%]">{renderHeader("Portal URL", "url")}</TableHead>
                            <TableHead>Portal Email</TableHead>
                            <TableHead>Username</TableHead>
                            <TableHead>Password</TableHead>
                            <TableHead>{renderHeader("Auth Type", "auth")}</TableHead>
                            <TableHead>Health</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            [...Array(4)].map((_, i) => (
                                <TableRow key={i}>
                                    <TableCell />
                                    {[...Array(8)].map((__, j) => (
                                        <TableCell key={j}>
                                            <Skeleton className="h-4 w-full" />
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))
                        ) : sorted.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={9} className="h-24 text-center text-sm text-slate-500">
                                    {search
                                        ? `No panels match "${search}"`
                                        : "No panels linked to this hospital yet."}
                                </TableCell>
                            </TableRow>
                        ) : (
                            sorted.map((panel) => {
                                const isOpen = expanded.has(panel.hospital_panel_id);
                                const url = readValue(findAttr(panel, "portal_url"));
                                const email = readValue(findAttr(panel, "portal_email"));
                                const username = readValue(findAttr(panel, "portal_username"));
                                const password = readValue(findAttr(panel, "portal_password"));
                                const authRaw = findAttr(panel, "authentication_type");
                                const auth = readValue(authRaw);
                                const health = computeHealth(panel);

                                // Build the "other attributes" list — everything that isn't a
                                // primary column and that has a value.
                                const primarySet = new Set<string>(PRIMARY_KEYS);
                                const otherAttrs = panel.attributes
                                    .filter((a) => !primarySet.has(a.attribute_key as any))
                                    .filter((a) => {
                                        const v = readValue(a);
                                        return v !== "" && v != null;
                                    });

                                // Group other attrs by category for the expanded row layout.
                                const grouped = otherAttrs.reduce<Record<string, FleetAttribute[]>>(
                                    (acc, a) => {
                                        const c = a.category || "other";
                                        (acc[c] = acc[c] || []).push(a);
                                        return acc;
                                    },
                                    {}
                                );

                                return (
                                    <React.Fragment key={panel.hospital_panel_id}>
                                        <TableRow
                                            className="hover:bg-muted/40 transition-colors cursor-pointer group"
                                            onClick={() => toggleExpand(panel.hospital_panel_id)}
                                        >
                                            <TableCell className="w-8">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-7 w-7 p-0"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleExpand(panel.hospital_panel_id);
                                                    }}
                                                    title={isOpen ? "Collapse" : "Expand"}
                                                >
                                                    {isOpen ? (
                                                        <ChevronDown className="h-4 w-4" />
                                                    ) : (
                                                        <ChevronRight className="h-4 w-4" />
                                                    )}
                                                </Button>
                                            </TableCell>
                                            <TableCell className="font-medium">
                                                <div className="flex items-center gap-2.5 min-w-0">
                                                    <Avatar className="h-8 w-8 rounded-md shrink-0">
                                                        <AvatarFallback className="rounded-md bg-brand-50 text-brand-600 font-semibold text-xs">
                                                            {panel.panel_name.charAt(0).toUpperCase()}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <span className="truncate">{panel.panel_name}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                {url ? (
                                                    <a
                                                        href={url}
                                                        target="_blank"
                                                        rel="noreferrer noopener"
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline truncate max-w-[200px]"
                                                        title={url}
                                                    >
                                                        <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
                                                        <ExternalLink className="h-3 w-3 shrink-0" />
                                                    </a>
                                                ) : (
                                                    <span className="text-xs text-slate-400">—</span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <CredentialValue value={email} />
                                            </TableCell>
                                            <TableCell>
                                                <CredentialValue value={username} monospace />
                                            </TableCell>
                                            <TableCell>
                                                <CredentialValue value={password} masked monospace />
                                            </TableCell>
                                            <TableCell>
                                                {auth ? (
                                                    <Badge variant="secondary" className="text-xs">
                                                        {auth}
                                                    </Badge>
                                                ) : (
                                                    <span className="text-xs text-slate-400">—</span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <HealthPill status={health} />
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onConfigure(panel.panel_id);
                                                    }}
                                                    className="gap-1"
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                    Configure
                                                </Button>
                                            </TableCell>
                                        </TableRow>

                                        {isOpen && (
                                            <TableRow className="bg-slate-50/50 hover:bg-slate-50/50">
                                                <TableCell />
                                                <TableCell colSpan={8} className="py-4">
                                                    {otherAttrs.length === 0 ? (
                                                        <div className="flex items-center justify-between gap-4">
                                                            <p className="text-sm text-slate-500">
                                                                No additional attributes configured for this panel yet.
                                                            </p>
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="gap-1"
                                                                onClick={() => onConfigure(panel.panel_id)}
                                                            >
                                                                <Plus className="h-3.5 w-3.5" />
                                                                Add attribute
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <div className="space-y-4">
                                                            {Object.entries(grouped).map(([cat, attrs]) => (
                                                                <div key={cat}>
                                                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                                                                        {cat}
                                                                    </div>
                                                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
                                                                        {attrs.map((a) => {
                                                                            const isSecret =
                                                                                a.data_type === "encrypted_text";
                                                                            return (
                                                                                <div
                                                                                    key={a.id}
                                                                                    className="flex items-start justify-between gap-2 border-b border-slate-100 py-1.5"
                                                                                >
                                                                                    <div className="text-xs text-slate-500 min-w-0 truncate flex-1">
                                                                                        {a.label}
                                                                                    </div>
                                                                                    <div className="flex-1 min-w-0">
                                                                                        <CredentialValue
                                                                                            value={readValue(a)}
                                                                                            masked={isSecret}
                                                                                            monospace={isSecret}
                                                                                        />
                                                                                    </div>
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </React.Fragment>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
};

export default PanelsFleetTable;
