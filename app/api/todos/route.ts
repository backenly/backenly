export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/route-protection';

const todos: any[] = [];

export const GET = withAuth(async (request: NextRequest, { user }) => {
  return NextResponse.json({ todos });
});

export const POST = withAuth(async (request: NextRequest, { user }) => {
  const { title } = await request.json();
  const newTodo = { id: todos.length + 1, title, completed: false, userId: user.userId };
  todos.push(newTodo);
  return NextResponse.json(newTodo, { status: 201 });
});

export const PUT = withAuth(async (request: NextRequest, { user }) => {
  const { id, title, completed } = await request.json();
  const todo = todos.find(t => t.id === id);
  if (todo) {
    todo.title = title;
    todo.completed = completed;
    return NextResponse.json(todo);
  }
  return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
});

export const DELETE = withAuth(async (request: NextRequest, { user }) => {
  const { id } = await request.json();
  const index = todos.findIndex(t => t.id === id);
  if (index !== -1) {
    todos.splice(index, 1);
    return NextResponse.json({ message: 'Todo deleted' });
  }
  return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
});
