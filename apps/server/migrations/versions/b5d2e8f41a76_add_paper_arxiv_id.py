"""add papers.arxiv_id

Revision ID: b5d2e8f41a76
Revises: e7a2c94f1b38
Create Date: 2026-08-25 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b5d2e8f41a76'
down_revision: Union[str, None] = 'e7a2c94f1b38'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.add_column(sa.Column('arxiv_id', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('papers', schema=None) as batch_op:
        batch_op.drop_column('arxiv_id')
