import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search } from "lucide-react";
import HospitalAttributeDefinitionsManager from "./HospitalAttributeDefinitionsManager";
import PanelAttributeDefinitionsManager from "./PanelAttributeDefinitionsManager";
import DoctorAttributeDefinitionsManager from "./DoctorAttributeDefinitionsManager";

const AttributeDefinitionsManager: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("hospital");

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="hospital">Hospital Attributes</TabsTrigger>
          <TabsTrigger value="panel">Panel Attributes</TabsTrigger>
          <TabsTrigger value="doctor">Doctor Attributes</TabsTrigger>
        </TabsList>

        <TabsContent value="hospital" className="space-y-6">
          <HospitalAttributeDefinitionsManager searchTerm={searchTerm} />
        </TabsContent>

        <TabsContent value="panel" className="space-y-6">
          <PanelAttributeDefinitionsManager searchTerm={searchTerm} />
        </TabsContent>

        <TabsContent value="doctor" className="space-y-6">
          <DoctorAttributeDefinitionsManager searchTerm={searchTerm} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AttributeDefinitionsManager;
