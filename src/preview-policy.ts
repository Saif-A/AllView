/** Only document previews restore the shared navigation preference. */
export function documentPreview(kind:string|undefined){
 return !!kind&&['text','json','markdown','pdf','html','rtf','epub','email','notebook','spreadsheet','package-document','paged','engine-word','engine-wordperfect','engine-hangul','engine-iwork','engine-email','engine-presentation','engine-spreadsheet'].includes(kind);
}
export function imagePreview(kind:string|undefined){return !!kind&&['image','convert-image','svg','metafile'].includes(kind)}
