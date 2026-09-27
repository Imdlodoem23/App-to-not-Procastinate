import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('centrate', {
  platform: process.platform,
});
