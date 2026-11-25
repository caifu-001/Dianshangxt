import { createClient } from '@supabase/supabase-js'

const FALLBACK_URL = 'https://rjdoimnicmibxfwcjchn.supabase.co'
const FALLBACK_KEY = 'sb_publishable_vBOpo9IQaKPg4ACt_nLopg_oiJQAKhy'

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || FALLBACK_KEY

export const PROJECT_REF = SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0]

export const SQL_EDITOR_URL = `https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new`

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
