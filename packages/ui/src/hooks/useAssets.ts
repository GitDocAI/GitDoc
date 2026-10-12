import { useState, useCallback } from 'react';
import { assetService, type Asset, type AssetListResponse, type UpdateAssetRequest } from '../services/assetService';
import { useDocDataOptional } from '../components/DocDataProvider';

/**
 * Hook to handle asset operations within a documentation context
 */
export const useAssets = () => {
  const docData = useDocDataOptional();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const organizationId = docData?.organizationId;
  const documentationId = docData?.documentationId;
  const isControlPlane = docData?.backend === 'control-plane';

  const fetchAssets = useCallback(async () => {
    if (!docData || !isControlPlane || !organizationId || !documentationId) {
      if (!docData) console.warn('[useAssets] Cannot fetch assets: docData is not initialized');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const customUrl = docData.buildUrl('documentation','asset');
      const response: AssetListResponse = await assetService.getAssets(organizationId, documentationId, customUrl);
      setAssets(response.assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch assets');
    } finally {
      setLoading(false);
    }
  }, [isControlPlane, organizationId, documentationId, docData]);

  const uploadAsset = useCallback(async (file: File, name?: string, alt?: string) => {
    if (!docData || !organizationId || !documentationId) {
      throw new Error('Asset configuration missing (organizationId/documentationId)');
    }

    setLoading(true);
    setError(null);
    try {
      const customUrl = docData.buildUrl('documentation','asset');
      const asset = await assetService.uploadAsset(organizationId, documentationId, file, name, alt, customUrl);
      setAssets(prev => [asset, ...prev]);
      return asset;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to upload asset';
      setError(msg);
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, [isControlPlane, organizationId, documentationId, docData]);

  const generateImage = useCallback(async (prompt: string, opts?: { width?: number; height?: number; alt?: string }) => {
    if (!docData || !organizationId || !documentationId) {
      throw new Error('Asset configuration missing (organizationId/documentationId)');
    }
    setError(null);
    try {
      const customUrl = docData.buildUrl('documentation', 'ai/generate-image');
      const asset = await assetService.generateImage(organizationId, documentationId, prompt, opts, customUrl);
      setAssets(prev => [asset, ...prev]);
      return asset;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate image';
      setError(msg);
      throw new Error(msg);
    }
  }, [organizationId, documentationId, docData]);

  const downloadAsset = useCallback(async (assetId: string) => {
    if (!docData || !isControlPlane || !organizationId || !documentationId) {
      throw new Error('Asset download is not configured or only available in control-plane mode');
    }

    try {
      const customUrl = docData.buildUrl('documentation',`asset/${assetId}/file`);
      return await assetService.downloadAsset(organizationId, documentationId, assetId, customUrl);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to download asset');
    }
  }, [isControlPlane, organizationId, documentationId, docData]);

  const deleteAsset = useCallback(async (assetId: string) => {
    if (!docData || !isControlPlane || !organizationId || !documentationId) {
      throw new Error('Asset deletion is not configured');
    }

    try {
      const customUrl = docData.buildUrl('documentation',`asset/${assetId}`);
      await assetService.deleteAsset(organizationId, documentationId, assetId, customUrl);
      setAssets(prev => prev.filter(a => a.id !== assetId));
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to delete asset');
    }
  }, [isControlPlane, organizationId, documentationId, docData]);

  const updateAsset = useCallback(async (assetId: string, data: UpdateAssetRequest) => {
    if (!docData || !isControlPlane || !organizationId || !documentationId) {
      throw new Error('Asset update is not configured');
    }

    try {
      const customUrl = docData.buildUrl('documentation',`asset/${assetId}`);
      const updated = await assetService.updateAsset(organizationId, documentationId, assetId, data, customUrl);
      setAssets(prev => prev.map(a => a.id === assetId ? updated : a));
      return updated;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to update asset');
    }
  }, [isControlPlane, organizationId, documentationId, docData]);

  return {
    assets,
    loading,
    error,
    fetchAssets,
    uploadAsset,
    generateImage,
    downloadAsset,
    deleteAsset,
    updateAsset,
    isControlPlane: !!isControlPlane,
    isConfigured: !!docData
  };
};
