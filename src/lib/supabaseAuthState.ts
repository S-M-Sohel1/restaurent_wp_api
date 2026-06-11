/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from '@supabase/supabase-js';
import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TABLE = 'baileys_auth';

async function read(id: string): Promise<any> {
  const { data } = await sb.from(TABLE).select('value').eq('id', id).maybeSingle();
  return data ? JSON.parse(JSON.stringify(data.value), BufferJSON.reviver) : null;
}

async function write(id: string, value: unknown): Promise<void> {
  await sb.from(TABLE).upsert({
    id,
    value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)),
    updated_at: new Date().toISOString(),
  });
}

async function remove(id: string): Promise<void> {
  await sb.from(TABLE).delete().eq('id', id);
}

export async function useSupabaseAuthState() {
  const creds: AuthenticationCreds = (await read('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let val = await read(`${type}-${id}`);
              if (type === 'app-state-sync-key' && val) {
                val = proto.Message.AppStateSyncKeyData.fromObject(val);
              }
              out[id] = val;
            }),
          );
          return out;
        },
        set: async (data: any): Promise<void> => {
          const tasks: Promise<void>[] = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = `${type}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}
