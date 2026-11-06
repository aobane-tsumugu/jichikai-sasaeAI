/** 紙や LINE の題だけでも何の話か分かるよう、文書の題に行事名が無ければ添える。 */
export function paperHeading(projectTitle: string, documentTitle: string): string {
  return documentTitle.includes(projectTitle) ? documentTitle : `${projectTitle} ${documentTitle}`;
}
