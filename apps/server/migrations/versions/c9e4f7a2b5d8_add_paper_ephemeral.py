"""add ephemeral to papers for temporary association-opened documents

Revision ID: c9e4f7a2b5d8
Revises: a7f3d9c1e2b4
Create Date: 2026-10-06
"""
from alembic import op
import sqlalchemy as sa

revision = "c9e4f7a2b5d8"
down_revision = "a7f3d9c1e2b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("papers", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("ephemeral", sa.Integer(), nullable=False, server_default="0")
        )


def downgrade() -> None:
    with op.batch_alter_table("papers", schema=None) as batch_op:
        batch_op.drop_column("ephemeral")
