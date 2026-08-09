import { Pool } from 'pg'
import { prisma } from './lib/db/prisma'
;(async()=>{
  const user = await prisma.user.create({ data: { email:`dbg-${Date.now()}@t.test`, password:'x', name:'d' } })
  const proj = await prisma.project.create({ data: { name:'dbg', userId: user.id } })
  const S = `workspace_${proj.id}`
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await pool.query(`CREATE SCHEMA "${S}"`)
    await pool.query(`CREATE TABLE "${S}"."events" (id serial primary key, k int, pad text)`)
    await pool.query(`INSERT INTO "${S}"."events"(k,pad) SELECT i, repeat('x',60) FROM generate_series(1,600000) i`)
    await pool.query(`CREATE INDEX idx_events_k ON "${S}"."events"(k)`)
    const q = async (label:string) => {
      const r = await pool.query(`SELECT COALESCE(s.n_tup_upd,0)+COALESCE(s.n_tup_del,0) AS w, s.n_tup_del, s.n_tup_upd
        FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid=t.oid
        WHERE n.nspname=$1 AND t.relname='events'`, [S])
      console.log(label, JSON.stringify(r.rows[0]))
    }
    await q('after insert :')
    await pool.query(`DELETE FROM "${S}"."events" WHERE k % 10 <> 0`)
    await q('after delete :')
    await pool.query(`VACUUM "${S}"."events"`)
    await q('after vacuum :')
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${S}" CASCADE`).catch(()=>{})
    await pool.end()
    await prisma.project.delete({ where:{id:proj.id} }).catch(()=>{})
    await prisma.user.delete({ where:{id:user.id} }).catch(()=>{})
  }
  process.exit(0)
})().catch(e=>{console.error(e); process.exit(1)})
