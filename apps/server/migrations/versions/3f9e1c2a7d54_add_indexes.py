"""add user_id / word_id indexes

Revision ID: 3f9e1c2a7d54
Revises: bd14f5e2e468
Create Date: 2026-08-19 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '3f9e1c2a7d54'
down_revision: Union[str, None] = 'bd14f5e2e468'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.create_index('ix_papers_user_id', ['user_id'], unique=False)

    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.create_index('ix_projects_user_id', ['user_id'], unique=False)

    with op.batch_alter_table('review_logs', schema=None) as batch_op:
        batch_op.create_index('ix_review_logs_word_id', ['word_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('review_logs', schema=None) as batch_op:
        batch_op.drop_index('ix_review_logs_word_id')

    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_index('ix_projects_user_id')

    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.drop_index('ix_papers_user_id')