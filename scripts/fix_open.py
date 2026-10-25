p='app/_pages/db-writer/page.tsx'
s=open(p,encoding='utf-8').read()
lines=s.split('\n')
# remove all standalone '<>' except the first one (outer data fragment)
idx=[i for i,l in enumerate(lines) if l.strip()=='<>']
print(idx)
for i in reversed(idx[1:]):
    del lines[i]
open(p,'w',encoding='utf-8').write('\n'.join(lines))
print("done")