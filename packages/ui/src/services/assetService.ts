import axiosInstance from '../utils/axiosInstance';

export type AssetType = 'image' | 'video' | 'svg' | 'file'

export interface Asset {
  id: string
  documentation_id: string
  name: string
  original_name: string
  type: AssetType
  mime_type: string
  size: number
  width?: number
  height?: number
  alt?: string
  url: string
  created_at: string
  updated_at: string
}

export interface UploadAssetRequest {
  file: File
  name?: string
  alt?: string
}

export interface UpdateAssetRequest {
  name?: string
  alt?: string
}

export interface AssetListResponse {
  assets: Asset[]
  total: number
}

class AssetService {
  /**
   * Upload an asset to a documentation
   * POST /:organization_id/:documentation_id/asset
   */
  async uploadAsset(organizationId: string, documentationId: string, file: File, name?: string, alt?: string, customUrl?: string): Promise<Asset> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/asset`;
    const formData = new FormData();
    formData.append('file', file);
    if (name) formData.append('name', name);
    if (alt) formData.append('alt', alt);

    try {
      const response = await axiosInstance.post(url, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to upload asset: ${error}`);
    }
  }

  /**
   * Generate an image with AI and store it as an asset.
   * POST /:organization_id/:documentation_id/ai/generate-image
   */
  async generateImage(
    organizationId: string,
    documentationId: string,
    prompt: string,
    opts?: { width?: number; height?: number; alt?: string },
    customUrl?: string,
  ): Promise<Asset> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/ai/generate-image`;
    try {
      const response = await axiosInstance.post(url, {
        prompt,
        width: opts?.width,
        height: opts?.height,
        alt: opts?.alt,
      });
      return response.data;
    } catch (error: any) {
      // Surface the backend message (e.g. the 402 "limit reached") when present.
      throw new Error(error?.response?.data?.error || 'Failed to generate image');
    }
  }

  /**
   * Get all assets for a documentation
   * GET /:organization_id/:documentation_id/asset
   */
  async getAssets(organizationId: string, documentationId: string, customUrl?: string): Promise<AssetListResponse> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/asset`;
    try {
      const response = await axiosInstance.get(url);
      return response.data as AssetListResponse;
    } catch (error) {
      throw new Error(`Failed to fetch assets: ${error}`);
    }
  }

  /**
   * Get an asset by ID
   * GET /:organization_id/:documentation_id/asset/:asset_id
   */
  async getAsset(organizationId: string, documentationId: string, assetId: string, customUrl?: string): Promise<Asset> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/asset/${assetId}`;
    try {
      const response = await axiosInstance.get(url);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch asset: ${error}`);
    }
  }

  /**
   * Download/Serve an asset file
   * GET /:organization_id/:documentation_id/asset/:asset_id/file
   */
  async downloadAsset(organizationId: string, documentationId: string, assetId: string, customUrl?: string): Promise<string> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/asset/${assetId}/file`;
    try {
      const response = await axiosInstance.get(url, {
        responseType: 'blob',
      });
      return URL.createObjectURL(response.data);
    } catch (error) {
      throw new Error(`Failed to download asset: ${error}`);
    }
  }

  /**
   * Delete an asset
   * DELETE /:organization_id/:documentation_id/asset/:asset_id
   */
  async deleteAsset(organizationId: string, documentationId: string, assetId: string, customUrl?: string): Promise<void> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/asset/${assetId}`;
    try {
      await axiosInstance.delete(url);
    } catch (error) {
      throw new Error(`Failed to delete asset: ${error}`);
    }
  }

  /**
   * Update an asset
   * PUT /:organization_id/:documentation_id/asset/:asset_id
   */
  async updateAsset(organizationId: string, documentationId: string, assetId: string, data: UpdateAssetRequest, customUrl?: string): Promise<Asset> {
    const url = customUrl || `/v1/documentation/${organizationId}/${documentationId}/asset/${assetId}`;
    try {
      const response = await axiosInstance.put(url, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update asset: ${error}`);
    }
  }
}

export const assetService = new AssetService();
