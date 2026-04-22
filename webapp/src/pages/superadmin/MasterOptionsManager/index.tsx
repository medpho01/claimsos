import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, Edit, Trash2, Plus, Loader } from 'lucide-react';
import ApiService from '@/services/api';
import CreateOptionModal from './CreateOptionModal';
import EditOptionModal from './EditOptionModal';
import DeleteConfirmModal from './DeleteConfirmModal';

interface MasterOption {
  id: string;
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface Category {
  category: string;
  count: number;
}

export default function MasterOptionsManager() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [options, setOptions] = useState<MasterOption[]>([]);
  const [filteredOptions, setFilteredOptions] = useState<MasterOption[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedOption, setSelectedOption] = useState<MasterOption | null>(null);

  // Load categories on mount
  useEffect(() => {
    loadCategories();
  }, []);

  // Load options when category changes
  useEffect(() => {
    if (selectedCategory) {
      loadOptions();
    }
  }, [selectedCategory]);

  // Filter options based on search term
  useEffect(() => {
    const filtered = options.filter(
      (option) =>
        option.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
        option.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (option.description?.toLowerCase() || '').includes(searchTerm.toLowerCase())
    );
    setFilteredOptions(filtered);
  }, [searchTerm, options]);

  const loadCategories = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await ApiService.get('/master-options/categories/list');
      if (response.data.data) {
        setCategories(response.data.data);
        // Auto-select first category
        if (response.data.data.length > 0 && !selectedCategory) {
          setSelectedCategory(response.data.data[0].category);
        }
      }
    } catch (err) {
      console.error('Error loading categories:', err);
      setError('Failed to load categories');
    } finally {
      setLoading(false);
    }
  };

  const loadOptions = async () => {
    if (!selectedCategory) return;
    try {
      setLoading(true);
      setError(null);
      const response = await ApiService.get(`/master-options/by-category/${selectedCategory}`);
      if (response.data.data) {
        setOptions(response.data.data);
        setSearchTerm('');
      }
    } catch (err) {
      console.error('Error loading options:', err);
      setError(`Failed to load options for category: ${selectedCategory}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSuccess = () => {
    setShowCreateModal(false);
    loadCategories();
    loadOptions();
    setSuccess('Option created successfully');
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleEditClick = (option: MasterOption) => {
    setSelectedOption(option);
    setShowEditModal(true);
  };

  const handleEditSuccess = () => {
    setShowEditModal(false);
    setSelectedOption(null);
    loadCategories();
    loadOptions();
    setSuccess('Option updated successfully');
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleDeleteClick = (option: MasterOption) => {
    setSelectedOption(option);
    setShowDeleteModal(true);
  };

  const handleDeleteSuccess = () => {
    setShowDeleteModal(false);
    setSelectedOption(null);
    loadCategories();
    loadOptions();
    setSuccess('Option deleted successfully');
    setTimeout(() => setSuccess(null), 3000);
  };

  const formatCategoryName = (category: string) => {
    return category
      .replace(/_/g, ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <div className="space-y-6">
      {/* Error Alert */}
      {error && (
        <Card className="border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertCircle className="h-5 w-5" />
              {error}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Success Alert */}
      {success && (
        <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
          <CardContent className="pt-6">
            <div className="text-green-600 dark:text-green-400">{success}</div>
          </CardContent>
        </Card>
      )}

      {/* Categories Dropdown */}
      <Card>
        <CardHeader>
          <CardTitle>Select Master Category</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && categories.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <select
                value={selectedCategory || ''}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="flex-1 max-w-sm px-4 py-2 border border-gray-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
              >
                <option value="">Choose a category...</option>
                {categories.map((cat) => (
                  <option key={cat.category} value={cat.category}>
                    {formatCategoryName(cat.category)} ({cat.count} options)
                  </option>
                ))}
              </select>
          )}
        </CardContent>
      </Card>

      {/* Options Table */}
      {selectedCategory && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{formatCategoryName(selectedCategory)} Options</CardTitle>
                <CardDescription>Manage options for this category</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="search"
                  placeholder="Search options..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-[250px]"
                />
                <Button onClick={() => setShowCreateModal(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Option
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredOptions.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                {searchTerm ? 'No options match your search.' : 'No options found for this category.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOptions.map((option) => (
                      <TableRow key={option.id}>
                        <TableCell className="font-medium">{option.label}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{option.code}</Badge>
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-sm text-muted-foreground">
                          {option.description || '—'}
                        </TableCell>
                        <TableCell>{option.sort_order}</TableCell>
                        <TableCell>
                          <Badge variant={option.is_active ? 'default' : 'secondary'}>
                            {option.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEditClick(option)}
                              title="Edit option"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteClick(option)}
                              title="Delete option"
                              className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Modals */}
      {showCreateModal && (
        <CreateOptionModal
          category={selectedCategory!}
          onSuccess={handleCreateSuccess}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {showEditModal && selectedOption && (
        <EditOptionModal
          option={selectedOption}
          onSuccess={handleEditSuccess}
          onClose={() => setShowEditModal(false)}
        />
      )}

      {showDeleteModal && selectedOption && (
        <DeleteConfirmModal
          option={selectedOption}
          onSuccess={handleDeleteSuccess}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
}
