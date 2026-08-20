"""add papers.sort_order

Revision ID: e7a2c94f1b38
Revises: 3f9e1c2a7d54
Create Date: 2026-08-20 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e7a2c94f1b38'
down_revision: Union[str, None] = '3f9e1c2a7d54'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.add_column(sa.Column('sort_order', sa.Integer(), nullable=False, server_default='0'))
    # 回填：每项目内按 (created_at desc, id desc) 编号 0..n-1，与升级前默认展示顺序一致
    op.execute(
        """
        UPDATE papers SET sort_order = (
            SELECT COUNT(*) FROM papers AS p2
            WHERE p2.project_id IS papers.project_id
              AND (p2.created_at > papers.created_at
                   OR (p2.created_at = papers.created_at AND p2.id > papers.id))
        )
        """
    )


def downgrade() -> None:
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.drop_column('sort_order')
