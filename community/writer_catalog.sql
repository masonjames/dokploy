WITH ns AS (SELECT oid,nspname,nspowner,nspacl FROM pg_namespace
 WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'),
r AS (SELECT c.*,n.nspname FROM pg_class c JOIN ns n ON n.oid=c.relnamespace),
p AS (SELECT p.*,n.nspname FROM pg_proc p JOIN ns n ON n.oid=p.pronamespace),
t AS (SELECT t.*,n.nspname FROM pg_type t JOIN ns n ON n.oid=t.typnamespace
 WHERE t.typrelid=0 AND t.typelem=0),
a AS (
 SELECT 'schema' kind,nspname identity,nspacl acl FROM ns
 UNION ALL SELECT 'relation',nspname||'.'||relname,relacl FROM r
 UNION ALL SELECT 'function',nspname||'.'||proname||'('||pg_get_function_identity_arguments(oid)||')',proacl FROM p
 UNION ALL SELECT 'type',nspname||'.'||typname,typacl FROM t),
sections AS (
 SELECT 'schemas' section,jsonb_build_array(nspname) item FROM ns
 UNION ALL SELECT 'relations',jsonb_build_array(nspname,relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity) FROM r WHERE relkind NOT IN ('i','I')
 UNION ALL SELECT 'columns',jsonb_build_array(r.nspname,r.relname,a.attnum,a.attname,
 format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))
 FROM r JOIN pg_attribute a ON a.attrelid=r.oid LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
 WHERE a.attnum>0 AND NOT a.attisdropped AND r.relkind NOT IN ('i','I','S')
 UNION ALL SELECT 'constraints',jsonb_build_array(n.nspname,c.relname,x.conname,pg_get_constraintdef(x.oid,true))
 FROM pg_constraint x JOIN ns n ON n.oid=x.connamespace LEFT JOIN pg_class c ON c.oid=x.conrelid WHERE x.contype<>'n'
 UNION ALL SELECT 'indexes',jsonb_build_array(nspname,relname,pg_get_indexdef(oid)) FROM r WHERE relkind IN ('i','I')
 UNION ALL SELECT 'enums',jsonb_build_array(t.nspname,t.typname,
 (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)) FROM t WHERE t.typtype='e'
 UNION ALL SELECT 'sequences',jsonb_build_array(r.nspname,r.relname,format_type(s.seqtypid,NULL),
 s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle,n.nspname,c.relname,a.attname)
 FROM r JOIN pg_sequence s ON s.seqrelid=r.oid
 LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=r.oid AND d.deptype IN ('a','i')
 LEFT JOIN pg_class c ON c.oid=d.refobjid LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid
 UNION ALL SELECT 'functions',jsonb_build_array(nspname,proname,pg_get_function_identity_arguments(oid),pg_get_functiondef(oid)) FROM p
 UNION ALL SELECT 'policies',jsonb_build_array(r.nspname,r.relname,x.polname,x.polcmd,x.polpermissive,
 (SELECT jsonb_agg(role_name ORDER BY role_name COLLATE "C") FROM
 (SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid)::text END role_name
 FROM unnest(x.polroles) role_oid) roles),pg_get_expr(x.polqual,x.polrelid),pg_get_expr(x.polwithcheck,x.polrelid))
 FROM pg_policy x JOIN r ON r.oid=x.polrelid
 UNION ALL SELECT 'triggers',jsonb_build_array(r.nspname,r.relname,x.tgname,pg_get_triggerdef(x.oid,true)) FROM pg_trigger x JOIN r ON r.oid=x.tgrelid WHERE NOT x.tgisinternal
 UNION ALL SELECT 'extensions',jsonb_build_array(e.extname,e.extversion,n.nspname,pg_get_userbyid(e.extowner)) FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
 UNION ALL SELECT 'owners',jsonb_build_array('schema',nspname,pg_get_userbyid(nspowner)) FROM ns
 UNION ALL SELECT 'owners',jsonb_build_array('relation',nspname||'.'||relname,pg_get_userbyid(relowner)) FROM r WHERE relkind NOT IN ('i','I')
 UNION ALL SELECT 'owners',jsonb_build_array('type',nspname||'.'||typname,pg_get_userbyid(typowner)) FROM t
 UNION ALL SELECT 'owners',jsonb_build_array('function',nspname||'.'||proname||'('||pg_get_function_identity_arguments(oid)||')',pg_get_userbyid(proowner)) FROM p
 UNION ALL SELECT 'grants',jsonb_build_array(a.kind,a.identity,CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable) FROM a CROSS JOIN LATERAL aclexplode(a.acl) x
 UNION ALL SELECT 'default_grants',jsonb_build_array(d.defaclobjtype,COALESCE(n.nspname,'*'),CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x
)
SELECT COALESCE(jsonb_object_agg(section,result_rows),'{}') FROM
 (SELECT section,jsonb_agg(item) result_rows FROM sections GROUP BY section) grouped;
