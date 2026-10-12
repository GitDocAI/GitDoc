import axios, { type AxiosRequestConfig, type AxiosResponse, AxiosError } from 'axios'
import { docDataService } from '../services/docDataService'

// Safe read so Node/SSG bundles (render-cli) don't crash on import — Vite-only globals.
const viteEnv = (import.meta as { env?: { VITE_MODE?: string; VITE_DEV_DOMAIN?: string } }).env
const viteMode = viteEnv?.VITE_MODE || 'production';
const viteDevDomain = viteEnv?.VITE_DEV_DOMAIN;

// Default axios instance
const axiosInstance = axios.create()

// Auth instance without /docs prefix (legacy, but we'll keep it for now)
export const authAxiosInstance = axios.create()

// Request interceptor for authAxiosInstance - adds Bearer token
authAxiosInstance.interceptors.request.use(
  async (config) => {
    // Attempt to get token dynamically
    const accessToken = await docDataService.getAuthToken()
    const publicPaths = ['/auth/login', '/auth/set-password', '/auth/forgot-password']
    const isPublicPath = publicPaths.some(path => config.url?.includes(path))

    if (accessToken && !isPublicPath) {
      config.headers.Authorization = `Bearer ${accessToken}`
    }
    
    // Set dynamic base URL if not already a full URL
    if (config.url && !config.url.startsWith('http')) {
       const context = docDataService.getContextValue()
       if (context) {
         config.baseURL = context.baseUrl.replace('/docs', '')
       }
    }

    if (viteDevDomain) {
      config.headers['X-Dev-Domain'] = viteDevDomain
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

export const setTokens = (accessToken: string, refreshToken: string) => {
  localStorage.setItem('accessToken', accessToken)
  localStorage.setItem('refreshToken', refreshToken)
}

export const getAccessToken = () => localStorage.getItem('accessToken')
export const getRefreshToken = () => localStorage.getItem('refreshToken')

export const clearTokens = () => {
  localStorage.removeItem('accessToken')
  localStorage.removeItem('refreshToken')
}

let isRefreshing = false
let failedQueue: Array<{ resolve: (value?: any) => void; reject: (reason?: any) => void; originalRequest: AxiosRequestConfig }> = []

const processQueue = (error: AxiosError | null, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error)
    } else {
      prom.resolve(token)
    }
  })
  failedQueue = []
}

// Request interceptor for adding the Bearer token and X-Dev-Domain header
axiosInstance.interceptors.request.use(
  async (config) => {
    // Attempt to get token dynamically
    const accessToken = await docDataService.getAuthToken()
    const loginPath = '/auth/login'
    
    // Check if the request URL is not the login path and a token exists
    if (accessToken && config.url && !config.url.includes(loginPath)) {
      config.headers.Authorization = `Bearer ${accessToken}`
    }

    // Set dynamic base URL if not already a full URL
    if (config.url && !config.url.startsWith('http')) {
      const context = docDataService.getContextValue()
      if (context) {
        config.baseURL = context.baseUrl
      }
    }

    // Add X-Dev-Domain header if configured
    if (viteDevDomain) {
      config.headers['X-Dev-Domain'] = viteDevDomain
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor for handling token refresh
axiosInstance.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config
    const refreshToken = getRefreshToken()
    const baseURL = originalRequest?.baseURL || axiosInstance.defaults.baseURL

    // If the error is 401 Unauthorized and not a refresh token request itself
    if (error.response?.status === 401 && originalRequest && originalRequest.url !== '/refresh-token'
      && viteMode=="production"
    ) {
      if (isRefreshing) {
        // If a token refresh is already in progress, add the original request to the queue
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject, originalRequest })
        })
      }

      isRefreshing = true

      return new Promise((resolve, reject) => {
        axios
          .post(`${baseURL}/refresh`, { refreshToken })
          .then((res: AxiosResponse) => {
            const { accessToken, refreshToken: newRefreshToken } = res.data
            setTokens(accessToken, newRefreshToken)
            originalRequest.headers.Authorization = `Bearer ${accessToken}`
            processQueue(null, accessToken)
            resolve(axiosInstance(originalRequest))
          })
          .catch((err: AxiosError) => {
            processQueue(err)
            clearTokens()
            if(viteMode !== 'production'){
              window.location.href = '/403'
            }else{
              window.location.href = '/auth/login' // Redirect to login on refresh failure
            }
            reject(err)
          })
          .finally(() => {
            isRefreshing = false
          })
      })
    }

    // Redirect to /403 on 401 in dev mode, but only if not already on /403
    if (error.response?.status === 401 && viteMode !== "production" && originalRequest?.url !== '/theme') {
      if (window.location.pathname !== '/403') {
        window.location.href = '/403'
      }
    }

    return Promise.reject(error)
  }
)

// Response interceptor for authAxiosInstance - handles token refresh
authAxiosInstance.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config
    const refreshToken = getRefreshToken()
    const publicPaths = ['/auth/login', '/auth/set-password', '/auth/forgot-password', '/auth/logout']
    const isPublicPath = publicPaths.some(path => originalRequest?.url?.includes(path))
    const baseURL = originalRequest?.baseURL || authAxiosInstance.defaults.baseURL

    // If the error is 401 Unauthorized and not a public path
    if (error.response?.status === 401 && originalRequest && !isPublicPath && viteMode === "production") {
      if (isRefreshing) {
        // If a token refresh is already in progress, add the original request to the queue
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject, originalRequest })
        })
      }

      isRefreshing = true

      return new Promise((resolve, reject) => {
        axios
          .post(`${baseURL}/auth/refresh`, { refresh_token: refreshToken })
          .then((res: AxiosResponse) => {
            const { access_token, refresh_token: newRefreshToken } = res.data
            setTokens(access_token, newRefreshToken)
            originalRequest.headers.Authorization = `Bearer ${access_token}`
            processQueue(null, access_token)
            resolve(authAxiosInstance(originalRequest))
          })
          .catch((err: AxiosError) => {
            processQueue(err)
            clearTokens()
            window.location.href = '/auth/login'
            reject(err)
          })
          .finally(() => {
            isRefreshing = false
          })
      })
    }

    return Promise.reject(error)
  }
)

export default axiosInstance

