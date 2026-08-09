import { Pool } from 'pg'
import { prisma } from './lib/db/prisma'
import { queryWorkspaceSchema } from './lib/services/workspaceDatabase'
import { detectIndexBloat } from './lib/autonomy/index-bloat'
;(async()=>{
  const user = await prisma.user.create({ data: { email:`dbg2-${Date.now()}@t.test`, password:'x', name:'d' } })
  const proj = await prisma.project.create({ data: { name:'dbg2', userId: user.id } })
  const S = `workspace_${proj.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await pool.query(`CREATE SCHEMA "${S}"`)
    await pool.query(`CREATE TABLE "${S}"."events" (id serial primary key, k int, pad text)`)
    await pool.query(`INSERT INTO "${S}"."events"(k,pad) SELECT i, repeat('x',60) FROM generate_series(1,600000) i`)
    await pool.query(`CREATE INDEX idx_events_k ON "${S}"."events"(k)`)
    await pool.query(`DELETE FROM "${S}"."events" WHERE k % 10 <> 0`)
    await pool.query(`VACUUM "${S}"."events"`)

    console.log('direct pgstatindex:', (await pool.query(`SELECT avg_leaf_density FROM pgstatindex(format('%I.%I',$1::text,$2::text)::regclass)`,[S,'idx_events_k'])).rows[0])

    try {
      const r:any = await queryWorkspaceSchema(proj.id,
        `SELECT avg_leaf_density FROM pgstatindex(format('%I.%I', $1::text, $2::text)::regclass)`, S, 'idx_events_k')
      console.log('via queryWorkspaceSchema:', JSON.stringify(r?.rows ?? r))
    } catch(e:any) { console.log('queryWorkspaceSchema THREW:', e.message) }

    console.log('detect:', JSON.stringify(await detectIndexBloat(proj.id)))
    const led = await prisma.projectPreference.findMany({ where:{projectId:proj.id, type:'index_bloat_scan'}, select:{key:true,value:true} })
    console.log('ledger:', JSON.stringify(led))
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`).catch(()=>{})
    await pool.end()
    await prisma.projectPreference.deleteMany({ where:{projectId:proj.id} }).catch(()=>{})
    await prisma.project.delete({ where:{id:proj.id} }).catch(()=>{})
    await prisma.user.delete({ where:{id:user.id} }).catch(()=>{})
  }
  process.exit(0)
})().catch(e=>{console.error(e); process.exit(1)})
