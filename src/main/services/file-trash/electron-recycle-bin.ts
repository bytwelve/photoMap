import { shell } from 'electron';
import type { RecycleBinPort } from './trash-service';

export class ElectronRecycleBin implements RecycleBinPort {
  public async move(filePath: string): Promise<void> {
    await shell.trashItem(filePath);
  }
}
