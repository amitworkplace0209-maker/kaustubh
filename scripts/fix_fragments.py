p='app/_pages/db-writer/page.tsx'
s=open(p,encoding='utf-8').read()
lines=s.split('\n')
idx=[i for i,l in enumerate(lines) if l.strip()=='</>']
print(idx)
# keep last occurrence (outer close before footer); remove others
for i in reversed(idx[:-1]):
    del lines[i]
open(p,'w',encoding='utf-8').write('\n'.join(lines))
print("done")