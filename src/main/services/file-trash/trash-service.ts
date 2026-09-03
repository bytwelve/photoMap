import { lstat } from 'node:fs/promises';
import type { TrashItemResult,TrashItemStatus } from '../../../shared/contracts';
import type { PhotoFileRecord } from '../../infrastructure/sqlite/catalog-repository';
import { resolveRegularFileWithin } from '../../infrastructure/filesystem/path-policy';
export interface RecycleBinPort {move(filePath:string):Promise<void>;}
export interface TrashRepository {
  getPhotoFileRecords(photoIds:string[]):PhotoFileRecord[];
  markTrashPending(photoId:string):boolean;
  invalidatePhotoForRescan(photoId:string):void;
  markTrashCompanionMoved(photoId:string,expectedAbsolutePath:string):void;
  settleTrashItem(photoId:string,status:TrashItemStatus):void;
}
export class TrashService {
  constructor(private readonly repository:TrashRepository,private readonly recycleBin:RecycleBinPort){}
  async moveConfirmed(photoIds:string[]):Promise<TrashItemResult[]> {
    const results:TrashItemResult[]=[];
    for(const photoId of new Set(photoIds)){
      const record=this.repository.getPhotoFileRecords([photoId])[0];
      if(!record || record.lifecycleState!=='active'){results.push({photoId,status:'not_found'});continue;}
      let status:TrashItemStatus='failed';
      try {
        const filePath=await resolveRegularFileWithin(record.rootPath,record.absolutePath),facts=await lstat(filePath);
        if(facts.size!==record.fileSize||facts.mtimeMs!==record.modifiedAtMs){results.push({photoId,status:'changed'});continue;}
        if(!this.repository.markTrashPending(photoId)){results.push({photoId,status:'not_found'});continue;}
        if(record.companionAbsolutePath){await this.recycleBin.move(await resolveRegularFileWithin(record.rootPath,record.companionAbsolutePath));this.repository.markTrashCompanionMoved(photoId,record.companionAbsolutePath);}
        await this.recycleBin.move(filePath);status='moved';
      }catch(error){const code=(error as NodeJS.ErrnoException).code;status=code==='ENOENT'?'not_found':code==='EACCES'||code==='EPERM'?'access_denied':'failed';}
      try{this.repository.settleTrashItem(photoId,status);}catch{status='index_failed';}
      results.push({photoId,status});
    }
    return results;
  }
}
